// Runs the eval questions through the ask handler and reports what came back. With no flag the
// model replies recorded in scripts/eval/fixtures.json stand in for the API, so the run is
// offline and repeatable, and any change in a response is reported as drift. A replay fails on
// drift, on a question the fixture lacks, and on any answer that misses its expectation, so CI
// catches a wrong answer as well as a changed one. --record calls
// the API and writes that file; --live calls the API and only reports. A fixture is tied to the
// model id, the prompt version and the schema hash the prompt embeds, so it must be recorded
// again when any of them changes. Runs under Node's type stripping, like build-db.ts.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import Anthropic from '@anthropic-ai/sdk';
import initSqlJs from 'sql.js';
import type { Database } from 'sql.js';
import { portfolioDbBase64 } from '../src/generated/portfolio-db.ts';
import { sqlWasmBase64 } from '../src/generated/sql-wasm.ts';
import { readConfig } from '../src/lib/ask/config.ts';
import { openDatabase } from '../src/lib/ask/db.ts';
import { handleAsk } from '../src/lib/ask/handler.ts';
import type { AskResult, ModelCall, ModelReply } from '../src/lib/ask/handler.ts';
import { PROMPT_VERSION, schemaHash8 } from '../src/lib/ask/prompt.ts';
import { skippedStore } from '../src/lib/ask/redis.ts';
import { questions } from './eval/questions.ts';
import type { EvalQuestion } from './eval/questions.ts';

interface RecordedReply {
  parsed_output: { sql: string; explanation: string } | null;
  stop_reason: string | null;
  usage: { input_tokens: number; output_tokens: number };
  latencyMs: number;
}

interface RecordedQuestion {
  question: string;
  replies: RecordedReply[];
  result: AskResult;
}

interface Fixture {
  model: string;
  promptVersion: number;
  schemaHash8: string;
  recordedAt: string;
  questions: RecordedQuestion[];
}

type Kind = 'sql' | 'refusal' | 'error';

// The console steps one row past the 50 it shows, so a check sees exactly what a visitor would.
const ROW_LIMIT = 51;
// USD per million tokens; only the default model's prices are known here.
const PRICE = { input: 1, output: 5 };

const mode = process.argv.includes('--record') ? 'record' : process.argv.includes('--live') ? 'live' : 'replay';
const fixturePath = resolve(process.env.EVAL_FIXTURE ?? 'scripts/eval/fixtures.json');

function complain(message: string): 1 {
  console.error(`eval: ${message}`);
  return 1;
}

function fixtureProblem(fixture: Fixture, model: string): string | null {
  if (fixture.model !== model) return `the fixture was recorded with ${fixture.model}, not ${model}; record it again`;
  if (fixture.promptVersion !== PROMPT_VERSION) {
    return `the fixture is for prompt version ${fixture.promptVersion}, not ${PROMPT_VERSION}; record it again`;
  }
  if (fixture.schemaHash8 !== schemaHash8) return `the fixture is for schema ${fixture.schemaHash8}, not ${schemaHash8}; record it again`;
  return null;
}

// Calls made and, in replay, whether the handler asked for one more than was recorded.
interface Counter {
  calls: number;
  overrun: boolean;
}

function replayModel(replies: RecordedReply[], counter: Counter): ModelCall {
  return async () => {
    const reply = replies[counter.calls];
    if (!reply) {
      counter.overrun = true;
      throw new Error('no recorded reply for this call');
    }
    counter.calls += 1;
    return { parsed_output: reply.parsed_output, stop_reason: reply.stop_reason as ModelReply['stop_reason'] };
  };
}

function liveModel(client: Anthropic, replies: RecordedReply[], counter: Counter): ModelCall {
  return async (params, options) => {
    counter.calls += 1;
    const start = performance.now();
    const message = await client.messages.parse(params, options);
    replies.push({
      parsed_output: message.parsed_output,
      stop_reason: message.stop_reason,
      usage: { input_tokens: message.usage.input_tokens ?? 0, output_tokens: message.usage.output_tokens },
      latencyMs: Math.round(performance.now() - start),
    });
    return message;
  };
}

// A second connection for the checks, so they never step the one the handler validates against.
async function checkDatabase(): Promise<Database> {
  const wasm = Buffer.from(sqlWasmBase64, 'base64');
  const SQL = await initSqlJs({ wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer });
  const db = new SQL.Database(Buffer.from(portfolioDbBase64, 'base64'));
  db.run('PRAGMA query_only = 1');
  return db;
}

function rows(db: Database, sql: string): unknown[][] {
  const statement = db.prepare(sql);
  try {
    const out: unknown[][] = [];
    while (out.length < ROW_LIMIT && statement.step()) out.push(statement.get());
    return out;
  } finally {
    statement.free();
  }
}

function kindOf(result: AskResult): Kind {
  if (result.status !== 200) return 'error';
  const { sql } = result.body;
  return sql === '' ? 'refusal' : typeof sql === 'string' ? 'sql' : 'error';
}

// null when the result meets the question's expectation, otherwise the reason it does not.
function checkProblem(entry: EvalQuestion, result: AskResult, db: Database): string | null {
  if (result.status !== 200) return `status ${result.status}: ${String(result.body.reason ?? result.body.error ?? '')}`;
  if (entry.expect === 'either') return null;
  const kind = kindOf(result);
  if (kind !== entry.expect) return `expected ${entry.expect}, got ${kind}`;
  if (kind !== 'sql' || (!entry.mustInclude && !entry.mustExclude)) return null;
  let text: string;
  try {
    text = JSON.stringify(rows(db, result.body.sql as string));
  } catch (error) {
    return `query failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  const quoted = (values: string[]) => values.map((value) => JSON.stringify(value)).join(', ');
  const missing = (entry.mustInclude ?? []).filter((needle) => !text.includes(needle));
  if (missing.length > 0) return `rows lack ${quoted(missing)}`;
  const present = (entry.mustExclude ?? []).filter((needle) => text.includes(needle));
  if (present.length > 0) return `rows contain ${quoted(present)}`;
  return null;
}

function driftNote(fresh: AskResult, recorded: AskResult): string {
  if (fresh.status !== recorded.status) return `drift: status was ${recorded.status}`;
  const keys = new Set([...Object.keys(fresh.body), ...Object.keys(recorded.body)]);
  const changed = [...keys].filter((key) => !isDeepStrictEqual(fresh.body[key], recorded.body[key]));
  return `drift: ${changed.join(', ')} changed`;
}

function percentile(sorted: number[], share: number): number {
  return sorted[Math.max(0, Math.ceil(sorted.length * share) - 1)] ?? 0;
}

function printStats(model: string, results: RecordedQuestion[], calls: number): void {
  const replies = results.flatMap((entry) => entry.replies);
  const total = (values: number[]) => values.reduce((sum, value) => sum + value, 0);
  const input = total(replies.map((reply) => reply.usage.input_tokens));
  const output = total(replies.map((reply) => reply.usage.output_tokens));
  const latencies = results.map((entry) => total(entry.replies.map((reply) => reply.latencyMs))).sort((a, b) => a - b);
  const perCall = (value: number) => (replies.length > 0 ? Math.round(value / replies.length) : 0);
  console.log(`model calls ${calls}, input tokens ${input}, output tokens ${output}`);
  console.log(
    model.startsWith('claude-haiku-4-5')
      ? `cost ${((input * PRICE.input + output * PRICE.output) / 1e6).toFixed(4)} USD`
      : `cost not known for ${model}`,
  );
  console.log(`latency per question p50 ${percentile(latencies, 0.5)} ms, p95 ${percentile(latencies, 0.95)} ms, max ${latencies.at(-1) ?? 0} ms`);
  console.log(`mean per call ${perCall(input)} input tokens, ${perCall(output)} output tokens`);
}

async function main(): Promise<number> {
  const config = readConfig((name) => process.env[name]);
  // Every mode runs on a store that never limits, so the limiter's secret only has to be present.
  config.limitSecret ??= 'eval';
  let fixture: Fixture | null = null;
  let client: Anthropic | null = null;
  if (mode === 'replay') {
    if (!existsSync(fixturePath)) return complain('no fixture file; run "npm run eval:record" to record one');
    fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as Fixture;
    const problem = fixtureProblem(fixture, config.model);
    if (problem) return complain(problem);
  } else {
    if (!config.apiKey) return complain('ANTHROPIC_API_KEY is not set');
    client = new Anthropic({ apiKey: config.apiKey, timeout: 15_000, maxRetries: 1 });
  }
  const recordedFor = new Map((fixture?.questions ?? []).map((entry) => [entry.question, entry]));
  const db = await openDatabase();
  const checks = await checkDatabase();
  const results: RecordedQuestion[] = [];
  let passed = 0;
  const missed: number[] = [];
  let drift = 0;
  let unrecorded = 0;
  let calls = 0;

  for (const [index, entry] of questions.entries()) {
    const recorded = recordedFor.get(entry.question);
    const replies = recorded?.replies ?? [];
    const counter: Counter = { calls: 0, overrun: false };
    const model = client ? liveModel(client, replies, counter) : replayModel(replies, counter);
    const result = await handleAsk({ question: entry.question }, 'eval', {
      config,
      store: skippedStore(),
      model,
      db,
      signal: new AbortController().signal,
      log: () => {},
    });
    calls += counter.calls;
    results.push({ question: entry.question, replies, result });

    const notes: string[] = [];
    const problem = checkProblem(entry, result, checks);
    if (problem) {
      notes.push(problem);
      missed.push(index + 1);
    } else passed += 1;
    if (fixture && !recorded) {
      unrecorded += 1;
      notes.push('not in the fixture');
    } else if (recorded && !isDeepStrictEqual(result, recorded.result)) {
      drift += 1;
      notes.push(counter.overrun ? 'drift: asked for more model calls than recorded' : driftNote(result, recorded.result));
    }
    console.log(`${String(index + 1).padStart(2)}  ${result.status}  ${kindOf(result).padEnd(7)}  ${problem ? 'fail' : 'pass'}  ${notes.join('; ')}`.trimEnd());
  }

  if (fixture) {
    const extra = unrecorded > 0 ? `, unrecorded ${unrecorded}` : '';
    console.log(`accuracy ${passed}/${questions.length}, drift ${drift}${extra}, model calls replayed ${calls}`);
    if (missed.length === 1) complain(`question ${missed[0]} missed its expectation`);
    if (missed.length > 1) complain(`questions ${missed.join(', ')} missed their expectations`);
    return drift + unrecorded + missed.length > 0 ? 1 : 0;
  }
  console.log(`accuracy ${passed}/${questions.length}`);
  printStats(config.model, results, calls);
  const broken = results.flatMap((entry, index) => (entry.result.status === 500 || entry.result.status === 503 ? [index + 1] : []));
  if (broken.length > 0) {
    return complain(`questions ${broken.join(', ')} ended with 500 or 503${mode === 'record' ? ', so no fixture was written' : ''}`);
  }
  if (mode === 'record') {
    const fresh: Fixture = { model: config.model, promptVersion: PROMPT_VERSION, schemaHash8, recordedAt: new Date().toISOString(), questions: results };
    writeFileSync(fixturePath, `${JSON.stringify(fresh, null, 2)}\n`);
    console.log('fixture written');
  }
  return 0;
}

process.exitCode = await main();
