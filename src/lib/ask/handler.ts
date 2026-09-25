// An ask from body to response, as a function over injected pieces (model, store, database,
// clock, deadline) so every branch can be tested with fakes. Order: input, kill switch, rate
// limit, cache, cap, model, validation. Nothing here logs or returns the question text or the
// visitor's address, and the address reaches the store only as limitKey's keyed hash.
import { createHash, createHmac } from 'node:crypto';
import { AnthropicError, APIError } from '@anthropic-ai/sdk';
import type { ParsedMessage } from '@anthropic-ai/sdk/lib/parser';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';
import type { Database } from 'sql.js';
import type { AskConfig } from './config.ts';
import { counterKeys, monthOf } from './counters.ts';
import { errorType, reasonFor } from './errors.ts';
import { normaliseQuestion } from './normalise.ts';
import { correctionTurn, PROMPT_VERSION, questionTurn, requestParams, schemaHash8 } from './prompt.ts';
import type { AskOutput } from './prompt.ts';
import { QUESTION_LENGTH } from './question.ts';
import { retryAfter, StoreError } from './redis.ts';
import { TTL } from './storage.ts';
import type { Store } from './redis.ts';
import { explanationProblem, validateSql } from './validate-sql.ts';

// The whole handler must answer inside the function's 30 s; the deadline leaves room to respond.
export const DEADLINE_MS = 27_000;
// A corrective retry is a second attempt with its own timeout, so it only starts with this much left.
export const RETRY_NEEDS_MS = 16_000;

export { QUESTION_LENGTH };

export type AskRequest = ReturnType<typeof requestParams>;
export type ModelReply = Pick<ParsedMessage<AskOutput>, 'parsed_output' | 'stop_reason'>;
export type ModelCall = (params: AskRequest, options: { signal: AbortSignal }) => Promise<ModelReply>;

export interface LogEntry {
  status: number;
  errorType: string | null;
  requestId: string | null;
  latencyMs: number;
}

export interface AskDeps {
  config: AskConfig;
  // null when production has no Redis variables.
  store: Store | null;
  // null when there is no API key.
  model: ModelCall | null;
  db: Database;
  signal: AbortSignal;
  now?: () => number;
  log: (entry: LogEntry) => void;
}

export interface AskResult {
  status: number;
  body: Record<string, unknown>;
  // Headers beyond the fixed ones: a 429 carries Retry-After.
  headers?: Record<string, string>;
}

const unusable = { error: 'unusable_output' };

export function readQuestion(body: unknown): string | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const value = (body as { question?: unknown }).question;
  if (typeof value !== 'string') return null;
  const question = value.trim();
  return question.length >= QUESTION_LENGTH.min && question.length <= QUESTION_LENGTH.max ? question : null;
}

export function cacheKey(env: string, question: string): string {
  const digest = createHash('sha256').update(normaliseQuestion(question)).digest('hex');
  return `ask:${env}:cache:v${PROMPT_VERSION}:${schemaHash8}:${digest}`;
}

// The rate limiter's key for an address. A plain hash of an IPv4 address can be reversed by
// hashing every address in turn; keyed with a secret, the stored key cannot be matched back to
// an address without the secret. The storage table's "scrambled form of your address" relies on
// this, so a change here changes that row.
export function limitKey(secret: string, ip: string): string {
  return createHmac('sha256', secret).update(ip).digest('hex');
}

export async function handleAsk(body: unknown, ip: string, deps: AskDeps): Promise<AskResult> {
  const now = deps.now ?? Date.now;
  const start = now();
  const done = (status: number, result: Record<string, unknown>, type: string | null = null, requestId: string | null = null): AskResult => {
    deps.log({ status, errorType: type, requestId, latencyMs: now() - start });
    return { status, body: result };
  };

  const question = readQuestion(body);
  if (question === null) return done(400, { error: 'invalid_question' }, 'input');
  const { config, store, model, db, signal } = deps;
  if (config.cap === 0) return done(503, { reason: 'budget' }, 'cap');
  if (!store) return done(503, { reason: 'config' }, 'redis');
  // Without the secret there is no key that keeps the address out of the store, so the endpoint closes.
  if (!config.limitSecret) return done(503, { reason: 'config' }, 'limit_secret');

  try {
    const allowance = await store.allow(limitKey(config.limitSecret, ip));
    if (!allowance.allowed) return { ...done(429, { error: 'rate_limited' }, 'rate_limit'), headers: retryAfter(allowance.resetAt, now()) };

    const { asked: askedKey, model: modelKey } = counterKeys(config.env, monthOf(now()));
    const key = cacheKey(config.env, question);

    // Cached answers are free, so they are served even in a used-up month.
    const hit = await store.read(key);
    if (hit) {
      await store.count(askedKey, TTL.counter);
      return done(200, { sql: hit.sql, explanation: hit.explanation, cached: true });
    }
    if (!model) return done(503, { reason: 'config' }, 'api_key');

    const messages: MessageParam[] = [{ role: 'user', content: questionTurn(question) }];
    let retried = false;
    for (;;) {
      // Reserve the call before making it: the counter bounds spend exactly, retries and failures included.
      if ((await store.count(modelKey, TTL.counter)) > config.cap) return done(503, { reason: 'budget' }, 'cap');

      let reply: ModelReply;
      try {
        reply = await model(requestParams(config.model, config.maxTokens, messages), { signal });
      } catch (error) {
        if (error instanceof APIError) return done(503, { reason: reasonFor(error) }, errorType(error), error.requestID ?? null);
        // The SDK throws its base error when the reply is not the JSON the schema promised.
        if (error instanceof AnthropicError) return done(422, unusable, errorType(error));
        throw error;
      }

      const output = reply.parsed_output;
      if (!output || reply.stop_reason === 'max_tokens') return done(422, unusable, 'no_output');
      const explanation = output.explanation.trim();
      const problem = explanationProblem(explanation);
      if (problem) return done(422, unusable, problem);

      // A refusal is an empty sql with a reason; an empty sql without one falls through to the
      // validator and is unusable.
      if (output.sql.trim() === '' && explanation !== '') {
        await store.write(key, { sql: '', explanation }, TTL.refusal);
        await store.count(askedKey, TTL.counter);
        return done(200, { sql: '', explanation, cached: false });
      }

      const checked = validateSql(output.sql, db);
      if (checked.ok) {
        await store.write(key, { sql: checked.sql, explanation }, TTL.answer);
        await store.count(askedKey, TTL.counter);
        return done(200, { sql: checked.sql, explanation, cached: false });
      }
      if (checked.stage === 'engine' && !retried && now() - start <= DEADLINE_MS - RETRY_NEEDS_MS) {
        retried = true;
        messages.push({ role: 'assistant', content: JSON.stringify(output) }, { role: 'user', content: correctionTurn(checked.message) });
        continue;
      }
      return done(422, unusable, `validator_${checked.stage}`);
    }
  } catch (error) {
    if (error instanceof StoreError) return done(503, { reason: 'upstream' }, error.name);
    return done(500, { error: 'internal' }, errorType(error));
  }
}
