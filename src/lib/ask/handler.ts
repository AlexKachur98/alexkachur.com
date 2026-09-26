// An ask from body to response, as a function over injected pieces (model, store, database,
// clock, deadline) so every branch can be tested with fakes. Order: input, kill switch, rate
// limit, cache, cap, model, validation. Nothing here logs or returns the question text or the
// visitor's address, and the address reaches the store only as limitKey's keyed hash.
import { AnthropicError, APIError } from '@anthropic-ai/sdk';
import type { ParsedMessage } from '@anthropic-ai/sdk/lib/parser';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';
import type { Database } from 'sql.js';
import { FUNCTION_SECONDS, MODEL } from './config.ts';
import type { AskConfig } from './config.ts';
import { errorType, reasonFor } from './errors.ts';
import { counterKeys, limitKey, monthOf, questionDigest } from './keys.ts';
import { correctionTurn, PROMPT_VERSION, questionTurn, requestParams, schemaHash8 } from './prompt.ts';
import type { AskOutput } from './prompt.ts';
import { readQuestion } from './question.ts';
import type { Store } from './redis.ts';
import { failed, finisher, rateLimited } from './result.ts';
import type { EndpointResult, LogEntry } from './result.ts';
import { TTL } from './storage.ts';
import { explanationProblem, validateSql } from './validate-sql.ts';

// The whole handler must answer inside the function's time limit; the deadline leaves room to respond.
export const DEADLINE_MS = FUNCTION_SECONDS * 1000 - 3_000;
// A corrective retry is a second attempt with its own timeout, so it only starts with this much left.
const RETRY_NEEDS_MS = MODEL.timeoutMs + 1_000;

export type AskRequest = ReturnType<typeof requestParams>;
export type ModelReply = Pick<ParsedMessage<AskOutput>, 'parsed_output' | 'stop_reason'>;
export type ModelCall = (params: AskRequest, options: { signal: AbortSignal }) => Promise<ModelReply>;

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

const unusable = { error: 'unusable_output' };

export function cacheKey(env: string, question: string): string {
  return `ask:${env}:cache:v${PROMPT_VERSION}:${schemaHash8}:${questionDigest(question)}`;
}

export async function handleAsk(body: unknown, ip: string, deps: AskDeps): Promise<EndpointResult> {
  const now = deps.now ?? Date.now;
  const start = now();
  const done = finisher(deps.log, now, start);

  const question = readQuestion(body);
  if (question === null) return done(400, { error: 'invalid_question' }, 'input');
  const { config, store, model, db, signal } = deps;
  if (config.cap === 0) return done(503, { reason: 'budget' }, 'cap');
  if (!store) return done(503, { reason: 'config' }, 'redis');
  // Without the secret there is no key that keeps the address out of the store, so the endpoint closes.
  if (!config.limitSecret) return done(503, { reason: 'config' }, 'limit_secret');

  try {
    const allowance = await store.allow(limitKey(config.limitSecret, ip));
    if (!allowance.allowed) return rateLimited(done, allowance.resetAt, now());

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
      // Reserve the call before making it, so the counter holds every call made, retries and
      // failures included. A refused reservation is taken back.
      if ((await store.count(modelKey, TTL.counter)) > config.cap) {
        await store.release(modelKey);
        return done(503, { reason: 'budget' }, 'cap');
      }

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
    return failed(done, error);
  }
}
