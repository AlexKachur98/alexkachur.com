import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { AskConfig } from '../src/lib/ask/config.ts';
import { limitKey } from '../src/lib/ask/handler.ts';
import type { AskResult, LogEntry } from '../src/lib/ask/handler.ts';
import { StoreError } from '../src/lib/ask/redis.ts';
import type { SentQuestion, Store } from '../src/lib/ask/redis.ts';
import { handleSend, mintToken, SEND, tokenKey, tokenValid, withToken } from '../src/lib/ask/send.ts';
import { DAY, stored, TTL } from '../src/lib/ask/storage.ts';

const SECRET = 'test-limit-secret';
const IP = '203.0.113.7';
const QUESTION = "What is Alex's favourite food?";
const NOW = Date.UTC(2026, 8, 24, 12, 0, 0);
const DAY_KEY = 'ask:test:sent:2026-09-24';

const config: AskConfig = { env: 'test', model: 'm', maxTokens: 512, cap: 100, apiKey: 'k', limitSecret: SECRET, redis: { url: 'u', token: 't' } };
const key = tokenKey(SECRET, 'test');

// Every write must be a row of the storage table, by key and lifetime; a sent question's lifetime
// counts from the start of the day it was sent. Noted rather than thrown, so the reason is kept.
const unlisted: string[] = [];

function listed(key: string, seconds: number): void {
  if (!stored.some((row) => row.where === 'redis' && row.key.test(key) && row.keep === seconds)) {
    unlisted.push(`${key} kept ${seconds} s is not in the storage table`);
  }
}

afterEach(() => {
  expect(unlisted.splice(0)).toEqual([]);
});

interface FakeStore extends Store {
  saved: Map<string, { entry: SentQuestion; expiresAt: number }>;
  counters: Map<string, { value: number; ttl: number }>;
  allowed: boolean;
  calls: string[];
  fail?: Error;
}

function fakeStore(): FakeStore {
  const store: FakeStore = {
    saved: new Map(),
    counters: new Map(),
    allowed: true,
    calls: [],
    async allow(k) {
      store.calls.push(`allow ${k}`);
      if (store.fail) throw store.fail;
      return { allowed: store.allowed, resetAt: NOW + 24_500 };
    },
    async read() {
      throw new Error('send must not read the cache');
    },
    async write() {
      throw new Error('send must not write the cache');
    },
    async count(k, ttl) {
      store.calls.push(`count ${k} ${ttl}`);
      listed(k, ttl);
      const counter = store.counters.get(k) ?? { value: 0, ttl };
      counter.value += 1;
      store.counters.set(k, counter);
      return counter.value;
    },
    async release() {
      throw new Error('send must not take back a count');
    },
    async counts() {
      throw new Error('send must not read the monthly counters');
    },
    async peek(k) {
      store.calls.push(`peek ${k}`);
      return store.counters.get(k)?.value ?? 0;
    },
    async save(k, entry, expiresAt) {
      store.calls.push(`save ${k}`);
      listed(k, expiresAt - Date.parse(`${entry.date}T00:00:00Z`) / 1000);
      if (store.saved.has(k)) return false;
      store.saved.set(k, { entry, expiresAt });
      return true;
    },
  };
  return store;
}

async function send(store: Store | null, body: unknown, overrides: Partial<AskConfig> = {}, now = NOW) {
  const logs: LogEntry[] = [];
  const result = await handleSend(body, IP, { config: { ...config, ...overrides }, store, now: () => now, log: (entry) => logs.push(entry) });
  return { ...result, logs };
}

const token = (question = QUESTION, at = NOW) => mintToken(key, question, at);

describe('the send token', () => {
  it('is valid for the exact question from the moment it is minted to ten minutes later', () => {
    const minted = token();
    expect(minted).toMatch(/^\d+\.[A-Za-z0-9_-]{43}$/);
    expect(tokenValid(key, QUESTION, minted, NOW)).toBe(true);
    expect(tokenValid(key, QUESTION, minted, NOW + SEND.windowSeconds * 1000)).toBe(true);
    expect(tokenValid(key, QUESTION, minted, NOW + (SEND.windowSeconds + 1) * 1000)).toBe(false);
  });

  it('allows a minute of clock difference for a token from the future and no more', () => {
    expect(tokenValid(key, QUESTION, token(QUESTION, NOW + 60_000), NOW)).toBe(true);
    expect(tokenValid(key, QUESTION, token(QUESTION, NOW + 61_000), NOW)).toBe(false);
  });

  it('fails for any other text, even one that asks the same thing', () => {
    const minted = token();
    expect(tokenValid(key, "what is alex's favourite food", minted, NOW)).toBe(false);
    expect(tokenValid(key, `${QUESTION} `, minted, NOW)).toBe(false);
    expect(tokenValid(key, 'Something never asked', minted, NOW)).toBe(false);
  });

  it('fails when altered, malformed or not a string', () => {
    const minted = token();
    const [seconds, sig] = minted.split('.');
    expect(tokenValid(key, QUESTION, `${Number(seconds) + 1}.${sig}`, NOW)).toBe(false);
    expect(tokenValid(key, QUESTION, `${seconds}.${sig!.slice(0, -1)}A`.replace(/AA$/, 'AB'), NOW)).toBe(false);
    for (const bad of [undefined, null, 42, '', 'x', `${seconds}.`, `${seconds}.${sig}.x`, ` ${minted}`]) {
      expect(tokenValid(key, QUESTION, bad, NOW), String(bad)).toBe(false);
    }
  });

  it('is signed with a key of its own, bound to the environment', () => {
    expect(key.equals(Buffer.from(SECRET))).toBe(false);
    // The rate limit's key for an address is the raw secret's HMAC; the token key is not that secret.
    expect(createHmac('sha256', key).update(IP).digest('hex')).not.toBe(limitKey(SECRET, IP));
    const preview = mintToken(tokenKey(SECRET, 'preview'), QUESTION, NOW);
    expect(tokenValid(tokenKey(SECRET, 'production'), QUESTION, preview, NOW)).toBe(false);
  });

  it('is added to every 200 from /api/ask, and to nothing else', () => {
    const answer: AskResult = { status: 200, body: { sql: '', explanation: 'No salary data.', cached: true } };
    const withIt = withToken(answer, { question: `  ${QUESTION}  ` }, config, NOW);
    expect(tokenValid(key, QUESTION, withIt.body.token, NOW)).toBe(true);
    expect(withToken({ status: 429, body: { error: 'rate_limited' } }, { question: QUESTION }, config, NOW).body).not.toHaveProperty('token');
    expect(withToken(answer, { question: QUESTION }, { ...config, limitSecret: undefined }, NOW).body).not.toHaveProperty('token');
    // A question the send endpoint would always refuse is never offered for sending.
    for (const question of ['What\u001bx?', 'Who is \u202Exela?']) {
      expect(withToken(answer, { question }, config, NOW).body, JSON.stringify(question)).not.toHaveProperty('token');
    }
  });
});

describe('POST /api/questions', () => {
  it('stores the question and the day with an expiry 90 days from the start of the day, and answers sent', async () => {
    const store = fakeStore();
    const result = await send(store, { question: QUESTION, token: token() });
    expect(result).toMatchObject({ status: 200, body: { sent: true } });
    const [[savedKey, saved]] = [...store.saved];
    expect(savedKey).toMatch(/^ask:test:question:[0-9a-f]{64}$/);
    expect(saved!.entry).toEqual({ question: QUESTION, date: '2026-09-24' });
    expect(saved!.expiresAt).toBe(Date.UTC(2026, 8, 24) / 1000 + 90 * DAY);
    expect(store.counters.get(DAY_KEY)).toEqual({ value: 1, ttl: TTL.sentDay });
  });

  it('keeps neither the address nor its keyed hash with the question or in the day count', async () => {
    const store = fakeStore();
    await send(store, { question: QUESTION, token: token() });
    const kept = JSON.stringify([...store.saved, ...store.counters]);
    expect(kept).not.toContain(IP);
    expect(kept).not.toContain(limitKey(SECRET, IP));
  });

  it('counts a question once however often its token is replayed, and answers the same each time', async () => {
    const store = fakeStore();
    const body = { question: QUESTION, token: token() };
    const first = await send(store, body);
    for (let i = 0; i < 60; i++) expect((await send(store, body)).body).toEqual(first.body);
    expect(store.saved.size).toBe(1);
    expect(store.counters.get(DAY_KEY)!.value).toBe(1);
  });

  it(`stops at ${SEND.dailyCap} a day with 429 daily_cap, storing nothing more`, async () => {
    const store = fakeStore();
    for (let i = 0; i < SEND.dailyCap; i++) {
      const question = `Question number ${i} about Alex?`;
      expect((await send(store, { question, token: token(question) })).status).toBe(200);
    }
    const last = 'One question too many?';
    // Noon UTC, so the day opens again in twelve hours.
    expect(await send(store, { question: last, token: token(last) })).toMatchObject({ status: 429, body: { error: 'daily_cap' }, headers: { 'Retry-After': String(12 * 60 * 60) } });
    expect(store.saved.size).toBe(SEND.dailyCap);
    // A new UTC day has its own count.
    const tomorrow = NOW + DAY * 1000;
    expect((await send(store, { question: last, token: token(last, tomorrow) }, {}, tomorrow)).status).toBe(200);
  });

  it('answers 429 rate_limited when the address is over the shared limit, storing nothing', async () => {
    const store = fakeStore();
    store.allowed = false;
    // The window has room again in 24.5 seconds, which the header rounds up to whole seconds.
    expect(await send(store, { question: QUESTION, token: token() })).toMatchObject({ status: 429, body: { error: 'rate_limited' }, headers: { 'Retry-After': '25' } });
    expect(store.saved.size).toBe(0);
  });

  it('refuses a missing, wrong or expired token with 403 before touching the store', async () => {
    const store = fakeStore();
    for (const body of [
      { question: QUESTION },
      { question: QUESTION, token: 'nonsense' },
      { question: 'Something else entirely?', token: token() },
      { question: QUESTION, token: token(QUESTION, NOW - (SEND.windowSeconds + 1) * 1000) },
    ]) {
      expect(await send(store, body)).toMatchObject({ status: 403, body: { error: 'invalid_token' } });
    }
    expect(store.calls).toEqual([]);
  });

  it('refuses a question that is too short, too long, or holds control or direction characters', async () => {
    const store = fakeStore();
    const control = 'What\u001b[2J is this?';
    const bidi = 'Who is \u202Exela?';
    for (const question of ['hi', 'x'.repeat(201), control, bidi]) {
      expect(await send(store, { question, token: token(question) }), JSON.stringify(question)).toMatchObject({
        status: 400,
        body: { error: 'invalid_question' },
      });
    }
    expect(store.calls).toEqual([]);
  });

  it('is off when asking is off, and never pretends to send without Redis', async () => {
    expect(await send(fakeStore(), { question: QUESTION, token: token() }, { cap: 0 })).toMatchObject({ status: 503, body: { reason: 'budget' } });
    expect(await send(null, { question: QUESTION, token: token() })).toMatchObject({ status: 503, body: { reason: 'config' } });
    expect(await send(fakeStore(), { question: QUESTION, token: token() }, { redis: null })).toMatchObject({ status: 503, body: { reason: 'config' } });
    expect(await send(fakeStore(), { question: QUESTION, token: token() }, { limitSecret: undefined })).toMatchObject({ status: 503, body: { reason: 'config' } });
  });

  it('answers 503 upstream when Redis fails and never logs the question', async () => {
    const store = fakeStore();
    store.fail = new StoreError(new Error('down'));
    const result = await send(store, { question: QUESTION, token: token() });
    expect(result).toMatchObject({ status: 503, body: { reason: 'upstream' } });
    expect(JSON.stringify(result.logs)).not.toContain('favourite');
  });
});
