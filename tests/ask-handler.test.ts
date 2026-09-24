import {
  AnthropicError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  AuthenticationError,
  BadRequestError,
  InternalServerError,
  NotFoundError,
  RateLimitError,
} from '@anthropic-ai/sdk';
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AskConfig } from '../src/lib/ask/config.ts';
import { openDatabase } from '../src/lib/ask/db.ts';
import { cacheKey, handleAsk, limitKey } from '../src/lib/ask/handler.ts';
import type { AskDeps, AskRequest, AskResult, LogEntry, ModelCall, ModelReply } from '../src/lib/ask/handler.ts';
import { StoreError } from '../src/lib/ask/redis.ts';
import type { CacheEntry, Store } from '../src/lib/ask/redis.ts';
import { stored } from '../src/lib/ask/storage.ts';

const IP = '203.0.113.7';
const LIMIT_SECRET = 'test-limit-secret';
const QUESTION = 'Which projects use a language model?';
const ASKED_KEY = 'ask:test:asked:2026-09';
const MODEL_KEY = 'ask:test:model:2026-09';

// Every distinctive message the fakes throw carries this marker, so a leak into a response
// body or a log line is one substring search away.
const SECRET = 'SECRET-DETAIL';

const db = await openDatabase();

// The clock: the handler measures latency and picks the month from now(), never from Date.
let t = Date.UTC(2026, 8, 22, 12, 0, 0);
const now = () => t;
const advance = (ms: number) => {
  t += ms;
};

type Call = [method: keyof Store, ...args: (string | number)[]];

interface FakeStore extends Store {
  entries: Map<string, { entry: CacheEntry; ttl: number }>;
  // The ttl is the one passed on the first count of the key, as Redis would keep it.
  counters: Map<string, { value: number; ttl: number }>;
  calls: Call[];
  allowed: boolean;
  fail: Partial<Record<keyof Store, Error>>;
}

// Every write in every scenario below must be a row of the storage table, by key and lifetime,
// so a branch that starts storing something new fails here until the table lists it. A write is
// noted rather than thrown, since the handler would turn a throw into a 500 and lose the reason.
const unlisted: string[] = [];

function listed(key: string, ttl: number): void {
  if (!stored.some((row) => row.where === 'redis' && row.key.test(key) && row.keep === ttl)) {
    unlisted.push(`${key} kept ${ttl} s is not in the storage table`);
  }
}

afterEach(() => {
  expect(unlisted.splice(0)).toEqual([]);
});

function fakeStore(): FakeStore {
  const throwIf = (method: keyof Store) => {
    const error = store.fail[method];
    if (error) throw error;
  };
  const store: FakeStore = {
    entries: new Map(),
    counters: new Map(),
    calls: [],
    allowed: true,
    fail: {},
    async allow(key) {
      store.calls.push(['allow', key]);
      throwIf('allow');
      return store.allowed;
    },
    async read(key) {
      store.calls.push(['read', key]);
      throwIf('read');
      return store.entries.get(key)?.entry ?? null;
    },
    async write(key, entry, ttl) {
      store.calls.push(['write', key, ttl]);
      throwIf('write');
      listed(key, ttl);
      store.entries.set(key, { entry, ttl });
    },
    async count(key, ttl) {
      store.calls.push(['count', key, ttl]);
      throwIf('count');
      listed(key, ttl);
      const counter = store.counters.get(key);
      if (counter) {
        counter.value += 1;
        return counter.value;
      }
      store.counters.set(key, { value: 1, ttl });
      return 1;
    },
    async counts(keys) {
      store.calls.push(['counts', ...keys]);
      throwIf('counts');
      return keys.map((key) => store.counters.get(key)?.value ?? 0);
    },
  };
  return store;
}

// A queued reply is returned, thrown, or computed at call time (to advance the clock or look
// at the store while the handler is waiting on the model).
type Reply = ModelReply | Error | ((params: AskRequest, signal: AbortSignal) => ModelReply | Error);

interface FakeModel {
  call: ModelCall;
  params: AskRequest[];
  signals: AbortSignal[];
  readonly calls: number;
}

function fakeModel(replies: Reply[]): FakeModel {
  const queue = [...replies];
  const model: FakeModel = {
    params: [],
    signals: [],
    get calls() {
      return model.params.length;
    },
    call: async (params, options) => {
      model.params.push(params);
      model.signals.push(options.signal);
      const next = queue.shift();
      if (next === undefined) throw new Error('fake model: no reply queued');
      const reply = typeof next === 'function' ? next(params, options.signal) : next;
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
  return model;
}

const ok = (sql: string, explanation: string): ModelReply => ({ parsed_output: { sql, explanation }, stop_reason: 'end_turn' });

const GOOD = ok('SELECT name FROM projects', 'Lists the project names.');
const BROKEN = ok('SELECT nope FROM projects', 'Lists nothing.');

interface Overrides {
  store?: FakeStore | null;
  model?: FakeModel | null;
  config?: Partial<AskConfig>;
  signal?: AbortSignal;
}

interface Run {
  result: AskResult;
  store: FakeStore;
  model: FakeModel;
  logs: LogEntry[];
}

function deps(overrides: Overrides, logs: LogEntry[]): AskDeps {
  return {
    config: {
      env: 'test',
      model: 'claude-haiku-4-5',
      maxTokens: 512,
      cap: 100,
      apiKey: 'k',
      limitSecret: LIMIT_SECRET,
      redis: { url: 'u', token: 't' },
      ...overrides.config,
    },
    store: overrides.store === undefined ? fakeStore() : overrides.store,
    model: overrides.model === undefined ? fakeModel([]).call : (overrides.model?.call ?? null),
    db,
    signal: overrides.signal ?? new AbortController().signal,
    now,
    log: (entry) => logs.push(entry),
  };
}

// The fakes come back even when the handler got null for them, so a test can assert they were
// left untouched.
async function send(body: unknown, overrides: Overrides = {}): Promise<Run> {
  const store = overrides.store === undefined ? fakeStore() : overrides.store;
  const model = overrides.model === undefined ? fakeModel([]) : overrides.model;
  const logs: LogEntry[] = [];
  const result = await handleAsk(body, IP, deps({ ...overrides, store, model }, logs));
  return { result, store: store ?? fakeStore(), model: model ?? fakeModel([]), logs };
}

const run = (question: string, overrides: Overrides = {}) => send({ question }, overrides);

const methods = (store: FakeStore) => store.calls.map((call) => call[0]);

function apiError(status: number, type: string, extra: Record<string, unknown> = {}, headers = new Headers()): APIError {
  const body = { type: 'error', error: { type, message: `${SECRET} from the API`, ...extra } };
  return APIError.generate(status, body, SECRET, headers);
}

const budget400 = () => apiError(400, 'invalid_request_error', { message: `You have reached your specified API usage limits. ${SECRET}` });

beforeEach(() => {
  t = Date.UTC(2026, 8, 22, 12, 0, 0);
});

describe('input', () => {
  const bad: [name: string, body: unknown][] = [
    ['an undefined body', undefined],
    ['a null body', null],
    ['an array body', []],
    ['a missing question', {}],
    ['a numeric question', { question: 42 }],
    ['two characters after trimming', { question: '  ab ' }],
    ['201 characters', { question: 'a'.repeat(201) }],
    ['300 characters', { question: 'a'.repeat(300) }],
  ];

  it.each(bad)('answers 400 to %s without touching the store or the model', async (_name, body) => {
    const { result, store, model } = await send(body);
    expect(result).toEqual({ status: 400, body: { error: 'invalid_question' } });
    expect(store.calls).toEqual([]);
    expect(model.calls).toBe(0);
  });

  it('accepts a three-character question', async () => {
    const { store } = await run('abc');
    expect(methods(store)).toContain('allow');
  });

  it('accepts a 200-character question', async () => {
    const { store } = await run('a'.repeat(200));
    expect(methods(store)).toContain('allow');
  });
});

describe('the kill switch', () => {
  it('answers 503 budget for cap 0 before the rate limit and the cache', async () => {
    const store = fakeStore();
    store.entries.set(cacheKey('test', QUESTION), { entry: { sql: 'SELECT 1', explanation: 'One.' }, ttl: 1 });
    const { result, model } = await run(QUESTION, { store, config: { cap: 0 } });
    expect(result).toEqual({ status: 503, body: { reason: 'budget' } });
    expect(store.calls).toEqual([]);
    expect(model.calls).toBe(0);
  });
});

describe('the rate limit', () => {
  it('answers 429 without sql when the address is over its window', async () => {
    const store = fakeStore();
    store.allowed = false;
    const model = fakeModel([GOOD]);
    const { result } = await run(QUESTION, { store, model });
    expect(result.status).toBe(429);
    expect(result.body).not.toHaveProperty('sql');
    expect(store.calls).toEqual([['allow', limitKey(LIMIT_SECRET, IP)]]);
    expect(model.calls).toBe(0);
  });

  // A plain hash of an IPv4 address can be reversed by trying every address; the key needs the secret.
  it('keys the limit by a keyed hash of the address, never the address', async () => {
    const { store } = await run(QUESTION, { model: fakeModel([GOOD]) });
    const [[, key]] = store.calls.filter(([method]) => method === 'allow');
    expect(key).toBe(createHmac('sha256', LIMIT_SECRET).update(IP).digest('hex'));
    expect(limitKey('another-secret', IP)).not.toBe(key);
    expect(limitKey(LIMIT_SECRET, '203.0.113.8')).not.toBe(key);
    expect(JSON.stringify(store.calls)).not.toContain(IP);
  });
});

describe('missing configuration', () => {
  it('answers 503 config without a store and never calls the model', async () => {
    const model = fakeModel([GOOD]);
    const { result } = await run(QUESTION, { store: null, model });
    expect(result).toEqual({ status: 503, body: { reason: 'config' } });
    expect(model.calls).toBe(0);
  });

  it('answers 503 config without the rate-limit secret, before the store or the model', async () => {
    const model = fakeModel([GOOD]);
    const { result, store, logs } = await run(QUESTION, { model, config: { limitSecret: undefined } });
    expect(result).toEqual({ status: 503, body: { reason: 'config' } });
    expect(logs).toEqual([{ status: 503, errorType: 'limit_secret', requestId: null, latencyMs: 0 }]);
    expect(store.calls).toEqual([]);
    expect(model.calls).toBe(0);
  });

  it('answers 503 config without a model, after the rate limit and the cache lookup', async () => {
    const { result, store } = await run(QUESTION, { model: null });
    expect(result).toEqual({ status: 503, body: { reason: 'config' } });
    expect(methods(store)).toEqual(['allow', 'read']);
  });
});

describe('the cache', () => {
  it('serves a stored answer and counts only the ask', async () => {
    const store = fakeStore();
    store.entries.set(cacheKey('test', QUESTION), { entry: { sql: 'SELECT name FROM projects', explanation: 'Lists the project names.' }, ttl: 1 });
    const model = fakeModel([GOOD]);
    const { result } = await run(QUESTION, { store, model });
    expect(result).toEqual({ status: 200, body: { sql: 'SELECT name FROM projects', explanation: 'Lists the project names.', cached: true } });
    expect(store.counters.get(ASKED_KEY)).toEqual({ value: 1, ttl: 3456000 });
    expect(store.counters.has(MODEL_KEY)).toBe(false);
    expect(model.calls).toBe(0);
  });

  it('serves a stored answer even when the month is over the cap', async () => {
    const store = fakeStore();
    store.counters.set(MODEL_KEY, { value: 500, ttl: 3456000 });
    store.entries.set(cacheKey('test', QUESTION), { entry: { sql: 'SELECT 1', explanation: 'One.' }, ttl: 1 });
    const { result, model } = await run(QUESTION, { store });
    expect(result).toEqual({ status: 200, body: { sql: 'SELECT 1', explanation: 'One.', cached: true } });
    expect(model.calls).toBe(0);
  });
});

describe('a fresh answer', () => {
  it('reserves the model call first, then caches the cleaned answer and counts the ask', async () => {
    const store = fakeStore();
    let reservedBeforeCall: Call[] = [];
    const model = fakeModel([
      () => {
        reservedBeforeCall = store.calls.filter((call) => call[0] === 'count');
        return ok('SELECT name FROM projects;', '  Lists the project names.  ');
      },
    ]);
    const { result } = await run(QUESTION, { store, model });
    expect(result).toEqual({ status: 200, body: { sql: 'SELECT name FROM projects', explanation: 'Lists the project names.', cached: false } });
    expect(reservedBeforeCall).toEqual([['count', MODEL_KEY, 3456000]]);
    expect(methods(store)).toEqual(['allow', 'read', 'count', 'write', 'count']);
    expect(store.counters.get(MODEL_KEY)).toEqual({ value: 1, ttl: 3456000 });
    expect(store.counters.get(ASKED_KEY)).toEqual({ value: 1, ttl: 3456000 });
    const key = cacheKey('test', QUESTION);
    expect(key.startsWith('ask:test:cache:')).toBe(true);
    expect(store.entries.get(key)).toEqual({ entry: { sql: 'SELECT name FROM projects', explanation: 'Lists the project names.' }, ttl: 2592000 });
  });
});

describe('the monthly cap', () => {
  it('answers 503 budget once the counter passes the cap', async () => {
    const store = fakeStore();
    store.counters.set(MODEL_KEY, { value: 100, ttl: 3456000 });
    const model = fakeModel([GOOD]);
    const { result } = await run(QUESTION, { store, model });
    expect(result).toEqual({ status: 503, body: { reason: 'budget' } });
    expect(model.calls).toBe(0);
  });

  it('allows the call that lands exactly on the cap', async () => {
    const store = fakeStore();
    store.counters.set(MODEL_KEY, { value: 99, ttl: 3456000 });
    const model = fakeModel([GOOD]);
    const { result } = await run(QUESTION, { store, model });
    expect(result.status).toBe(200);
    expect(model.calls).toBe(1);
    expect(store.counters.get(MODEL_KEY)?.value).toBe(100);
  });
});

describe('a refusal', () => {
  it('returns the empty sql, caches it for a day and counts both the call and the ask', async () => {
    const model = fakeModel([ok('', 'This database has no phone numbers.')]);
    const { result, store } = await run(QUESTION, { model });
    expect(result).toEqual({ status: 200, body: { sql: '', explanation: 'This database has no phone numbers.', cached: false } });
    expect(store.entries.get(cacheKey('test', QUESTION))).toEqual({ entry: { sql: '', explanation: 'This database has no phone numbers.' }, ttl: 86400 });
    expect(store.counters.get(ASKED_KEY)?.value).toBe(1);
    expect(store.counters.get(MODEL_KEY)?.value).toBe(1);
  });

  it('is not a refusal when the explanation is empty too', async () => {
    const model = fakeModel([ok('', ''), GOOD]);
    const { result, store } = await run(QUESTION, { model });
    expect(result).toEqual({ status: 422, body: { error: 'unusable_output' } });
    expect(model.calls).toBe(1);
    expect(methods(store)).not.toContain('write');
  });
});

describe('a valid query with an empty explanation', () => {
  it('is answered and cached with the explanation left empty', async () => {
    const model = fakeModel([ok('SELECT name FROM projects', '   ')]);
    const { result, store } = await run(QUESTION, { model });
    expect(result).toEqual({ status: 200, body: { sql: 'SELECT name FROM projects', explanation: '', cached: false } });
    expect(store.entries.get(cacheKey('test', QUESTION))).toEqual({ entry: { sql: 'SELECT name FROM projects', explanation: '' }, ttl: 2592000 });
  });
});

describe('unusable output', () => {
  const shapes: [name: string, reply: Reply][] = [
    ['no parsed output', { parsed_output: null, stop_reason: 'end_turn' }],
    ['a reply cut off by max_tokens', { parsed_output: { sql: 'SELECT name FROM projects', explanation: 'Lists names.' }, stop_reason: 'max_tokens' }],
    ['a reply the SDK could not parse', new AnthropicError(`Failed to parse structured output as JSON: ${SECRET}`)],
    ['an empty sql without a reason', ok('', '   ')],
    ['an explanation of 241 characters', ok('SELECT name FROM projects', 'x'.repeat(241))],
    ['an explanation with a URL', ok('SELECT name FROM projects', 'See https://example.com for the names.')],
    ['an explanation on two lines', ok('SELECT name FROM projects', 'Lists the names.\nAll of them.')],
    ['a write statement', ok('DELETE FROM projects', 'Removes every project.')],
    ['a read of sqlite_master', ok('SELECT * FROM sqlite_master', 'Lists the schema.')],
    ['two statements', ok('SELECT name FROM projects; SELECT 1', 'Lists the names.')],
  ];

  it.each(shapes)('answers 422 to %s after a single call', async (_name, reply) => {
    const model = fakeModel([reply, GOOD]);
    const { result, store } = await run(QUESTION, { model });
    expect(result).toEqual({ status: 422, body: { error: 'unusable_output' } });
    expect(model.calls).toBe(1);
    expect(methods(store)).not.toContain('write');
  });
});

describe('the corrective retry', () => {
  it('sends the engine message back once and answers with the corrected query', async () => {
    const model = fakeModel([BROKEN, GOOD]);
    const signal = new AbortController().signal;
    const { result, store } = await run(QUESTION, { model, signal });
    expect(result).toEqual({ status: 200, body: { sql: 'SELECT name FROM projects', explanation: 'Lists the project names.', cached: false } });
    expect(model.calls).toBe(2);
    expect(store.counters.get(MODEL_KEY)?.value).toBe(2);

    const messages = model.params[1]!.messages;
    expect(messages).toHaveLength(3);
    expect(messages[0]).toEqual({ role: 'user', content: `<question>${QUESTION}</question>` });
    expect(messages[1]).toEqual({ role: 'assistant', content: JSON.stringify({ sql: 'SELECT nope FROM projects', explanation: 'Lists nothing.' }) });
    expect(messages[2]!.role).toBe('user');
    expect(messages[2]!.content).toContain('no such column');
    expect(model.signals).toEqual([signal, signal]);
  });

  it('never retries twice', async () => {
    const model = fakeModel([BROKEN, BROKEN, GOOD]);
    const { result } = await run(QUESTION, { model });
    expect(result).toEqual({ status: 422, body: { error: 'unusable_output' } });
    expect(model.calls).toBe(2);
  });

  it('skips the retry when less than 16 seconds of the deadline remain', async () => {
    const model = fakeModel([
      () => {
        advance(11001);
        return BROKEN;
      },
      GOOD,
    ]);
    const { result } = await run(QUESTION, { model });
    expect(result.status).toBe(422);
    expect(model.calls).toBe(1);
  });

  it('still retries with exactly 16 seconds left', async () => {
    const model = fakeModel([
      () => {
        advance(11000);
        return BROKEN;
      },
      GOOD,
    ]);
    const { result } = await run(QUESTION, { model });
    expect(result.status).toBe(200);
    expect(model.calls).toBe(2);
  });

  it('counts the retry against the cap', async () => {
    const model = fakeModel([BROKEN, GOOD]);
    const { result, store } = await run(QUESTION, { model, config: { cap: 1 } });
    expect(result).toEqual({ status: 503, body: { reason: 'budget' } });
    expect(model.calls).toBe(1);
    expect(store.counters.get(MODEL_KEY)?.value).toBe(2);
  });
});

describe('API errors', () => {
  const mapped: [name: string, error: () => Error, reason: string][] = [
    ['a 401', () => apiError(401, 'authentication_error'), 'config'],
    ['a 404', () => apiError(404, 'not_found_error'), 'config'],
    ['a plain 429', () => apiError(429, 'rate_limit_error'), 'upstream'],
    ['a 429 for a reached spend limit', () => apiError(429, 'rate_limit_error', { details: { error_code: 'enforced_spend_limit_reached' } }), 'budget'],
    ['a 400 for a reached usage limit', budget400, 'budget'],
    ['a 529', () => apiError(529, 'overloaded_error'), 'upstream'],
    ['a connection timeout', () => new APIConnectionTimeoutError({ message: SECRET }), 'upstream'],
  ];

  it.each(mapped)('answers 503 to %s with reason %s', async (_name, error, reason) => {
    const thrown = error();
    const model = fakeModel([thrown, GOOD]);
    const { result } = await run(QUESTION, { model });
    expect(result).toEqual({ status: 503, body: { reason } });
    expect(model.calls).toBe(1);
  });

  it('builds the expected subclasses', () => {
    expect(apiError(401, 'authentication_error')).toBeInstanceOf(AuthenticationError);
    expect(apiError(404, 'not_found_error')).toBeInstanceOf(NotFoundError);
    expect(apiError(429, 'rate_limit_error')).toBeInstanceOf(RateLimitError);
    expect(budget400()).toBeInstanceOf(BadRequestError);
    expect(apiError(529, 'overloaded_error')).toBeInstanceOf(InternalServerError);
  });

  it('answers 503 upstream when the request was aborted', async () => {
    const model = fakeModel([
      (_params, signal) => (signal.aborted ? new APIUserAbortError({ message: SECRET }) : GOOD),
    ]);
    const { result } = await run(QUESTION, { model, signal: AbortSignal.abort() });
    expect(result).toEqual({ status: 503, body: { reason: 'upstream' } });
    expect(model.calls).toBe(1);
  });
});

describe('store failures', () => {
  const methodsOfStore: (keyof Store)[] = ['allow', 'read', 'count', 'write'];

  it.each(methodsOfStore)('answers 503 upstream when %s throws a StoreError', async (method) => {
    const store = fakeStore();
    store.fail[method] = new StoreError(new Error(SECRET));
    const { result } = await run(QUESTION, { store, model: fakeModel([GOOD]) });
    expect(result).toEqual({ status: 503, body: { reason: 'upstream' } });
    expect(JSON.stringify(result.body)).not.toContain(SECRET);
  });

  it.each(methodsOfStore)('answers 500 internal when %s throws a plain Error', async (method) => {
    const store = fakeStore();
    store.fail[method] = new Error(SECRET);
    const { result } = await run(QUESTION, { store, model: fakeModel([GOOD]) });
    expect(result).toEqual({ status: 500, body: { error: 'internal' } });
    expect(JSON.stringify(result.body)).not.toContain(SECRET);
  });
});

describe('leaks', () => {
  const failures: [name: string, overrides: () => Overrides][] = [
    ['an unparseable reply', () => ({ model: fakeModel([new AnthropicError(`Failed to parse structured output as JSON: ${SECRET}`)]) })],
    ['a 401', () => ({ model: fakeModel([apiError(401, 'authentication_error')]) })],
    ['a 404', () => ({ model: fakeModel([apiError(404, 'not_found_error')]) })],
    ['a plain 429', () => ({ model: fakeModel([apiError(429, 'rate_limit_error')]) })],
    ['a spend-limit 429', () => ({ model: fakeModel([apiError(429, 'rate_limit_error', { details: { error_code: 'enforced_spend_limit_reached' } })]) })],
    ['a usage-limit 400', () => ({ model: fakeModel([budget400()]) })],
    ['a 529', () => ({ model: fakeModel([apiError(529, 'overloaded_error')]) })],
    ['a timeout', () => ({ model: fakeModel([new APIConnectionTimeoutError({ message: SECRET })]) })],
    ['an abort', () => ({ model: fakeModel([new APIUserAbortError({ message: SECRET })]), signal: AbortSignal.abort() })],
    [
      'a store error',
      () => {
        const store = fakeStore();
        store.fail.read = new StoreError(new Error(SECRET));
        return { store };
      },
    ],
    [
      'a plain store error',
      () => {
        const store = fakeStore();
        store.fail.count = new Error(SECRET);
        return { store, model: fakeModel([GOOD]) };
      },
    ],
  ];

  it.each(failures)('keeps the message of %s out of the body and the log', async (_name, overrides) => {
    const { result, logs } = await run(QUESTION, overrides());
    expect(result.status).toBeGreaterThanOrEqual(422);
    expect(JSON.stringify(result.body)).not.toContain(SECRET);
    expect(logs).toHaveLength(1);
    expect(JSON.stringify(logs)).not.toContain(SECRET);
  });
});

describe('the log', () => {
  it('writes one entry with only status, errorType, requestId and latencyMs on success', async () => {
    const model = fakeModel([
      () => {
        advance(1234);
        return GOOD;
      },
    ]);
    const { logs } = await run(QUESTION, { model });
    expect(logs).toEqual([{ status: 200, errorType: null, requestId: null, latencyMs: 1234 }]);
  });

  it('writes one entry for a 400 with zero latency', async () => {
    const { logs } = await send(null);
    expect(logs).toEqual([{ status: 400, errorType: 'input', requestId: null, latencyMs: 0 }]);
  });

  it('records the request id of an API error', async () => {
    const error = apiError(529, 'overloaded_error', {}, new Headers({ 'request-id': 'req_x' }));
    const model = fakeModel([
      () => {
        advance(250);
        return error;
      },
    ]);
    const { logs } = await run(QUESTION, { model });
    expect(logs).toHaveLength(1);
    expect(Object.keys(logs[0]!).sort()).toEqual(['errorType', 'latencyMs', 'requestId', 'status']);
    expect(logs[0]).toMatchObject({ status: 503, requestId: 'req_x', latencyMs: 250 });
    expect(logs[0]!.errorType).toContain('InternalServerError');
  });

  it('never carries the question or the SQL', async () => {
    const outcomes = await Promise.all([
      run(QUESTION, { model: fakeModel([GOOD]) }),
      run(QUESTION, { model: fakeModel([BROKEN, BROKEN]) }),
      run(QUESTION, { model: fakeModel([ok('DELETE FROM projects', 'Removes every project.')]) }),
    ]);
    for (const { logs } of outcomes) {
      expect(logs).toHaveLength(1);
      const text = JSON.stringify(logs[0]);
      expect(text).not.toContain(QUESTION);
      expect(text).not.toContain('projects');
      expect(text).not.toContain('SELECT');
    }
  });
});

describe('the request', () => {
  it('sends the trimmed question between escaped tags with the configured model', async () => {
    const model = fakeModel([GOOD]);
    await run('  Who is <b>Alex</b> & what does he do?  ', { model });
    const params = model.params[0]!;
    expect(params.messages).toEqual([{ role: 'user', content: '<question>Who is &lt;b&gt;Alex&lt;/b&gt; & what does he do?</question>' }]);
    expect(params.model).toBe('claude-haiku-4-5');
    expect(params.max_tokens).toBe(512);
    expect(typeof params.system).toBe('string');
    expect(params.system).toContain('<question>');
    expect(params.output_config.format.type).toBe('json_schema');
  });

  it('takes the model id from the config', async () => {
    const model = fakeModel([GOOD]);
    await run(QUESTION, { model, config: { model: 'claude-test-model' } });
    expect(model.params[0]!.model).toBe('claude-test-model');
  });
});

describe('the month key', () => {
  it('follows the UTC month at the last second of December', async () => {
    t = Date.UTC(2026, 11, 31, 23, 59, 59);
    const { store } = await run(QUESTION, { model: fakeModel([GOOD]) });
    const keys = [...store.counters.keys()];
    expect(keys).toHaveLength(2);
    for (const key of keys) expect(key.endsWith(':2026-12')).toBe(true);
  });

  it('rolls over at the first second of January', async () => {
    t = Date.UTC(2027, 0, 1, 0, 0, 0);
    const { store } = await run(QUESTION, { model: fakeModel([GOOD]) });
    const keys = [...store.counters.keys()];
    expect(keys).toEqual(['ask:test:model:2027-01', 'ask:test:asked:2027-01']);
  });
});
