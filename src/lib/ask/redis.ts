// The Redis side of an ask: the sliding-window rate limit, the answer cache, the counters and the
// questions visitors chose to send, behind one small interface so the handlers can be tested
// with a fake.
import { Ratelimit } from '@upstash/ratelimit';
import type { Redis } from '@upstash/redis';
import { RATE_LIMIT } from './storage.ts';

export interface CacheEntry {
  sql: string;
  explanation: string;
}

// A question a visitor chose to send: its text and the day, nothing else.
export interface SentQuestion {
  question: string;
  date: string;
}

// Whether a key is inside its window and, when it is not, the moment the window lets it through
// again, so the refusal can say how long to wait.
export interface Allowance {
  allowed: boolean;
  // Epoch milliseconds; only meaningful when allowed is false.
  resetAt: number;
}

// The header a 429 carries: whole seconds until the moment given, never less than one.
export function retryAfter(resetAtMs: number, nowMs: number): Record<string, string> {
  return { 'Retry-After': String(Math.max(1, Math.ceil((resetAtMs - nowMs) / 1000))) };
}

export interface Store {
  // The key is the handler's keyed hash of the address, never the address itself.
  allow(key: string): Promise<Allowance>;
  read(key: string): Promise<CacheEntry | null>;
  write(key: string, entry: CacheEntry, ttlSeconds: number): Promise<void>;
  // INCR; the key's lifetime is set with its first count and never pushed back, so a counter
  // expires on its own.
  count(key: string, ttlSeconds: number): Promise<number>;
  // MGET of counters, one number per key; a key never incremented reads as 0.
  counts(keys: string[]): Promise<number[]>;
  // A counter's value without changing it; a key never incremented reads as 0.
  peek(key: string): Promise<number>;
  // SET NX with an absolute expiry in epoch seconds: true when it wrote, false when the key was
  // already there, whose expiry then stays as it was.
  save(key: string, entry: SentQuestion, expiresAt: number): Promise<boolean>;
}

// Wraps any Redis failure so the handler can answer 503 upstream without echoing the cause.
export class StoreError extends Error {
  constructor(cause: unknown) {
    super('redis command failed', { cause });
    this.name = 'StoreError';
  }
}

function isEntry(value: unknown): value is CacheEntry {
  if (value === null || typeof value !== 'object') return false;
  const entry = value as Partial<CacheEntry>;
  return typeof entry.sql === 'string' && typeof entry.explanation === 'string';
}

// The client comes from the caller, so a test can hand in a fake and see every key written.
export function redisStore(env: string, redis: Redis): Store {
  // With the sliding window each key expires two windows and a second after it is first set, and
  // with no in-memory cache the limiter keeps no key in the function's memory between requests.
  // Analytics stay off because they would store per-address identifiers. The storage table's
  // row for the rate limit takes its lifetime from the same window, and its "scrambled form of
  // your address" rests on the cache being off and on the handler's limitKey. With no timeout, a
  // slow Redis is waited for; the default lets the request through after 5 s.
  const limiter = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(RATE_LIMIT.requests, `${RATE_LIMIT.windowSeconds} s`),
    prefix: `ask:${env}:limit`,
    ephemeralCache: false,
    analytics: false,
    timeout: 0,
  });
  const guard = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      throw new StoreError(error);
    }
  };
  return {
    allow: (key) =>
      guard(async () => {
        const { success, reset } = await limiter.limit(key);
        return { allowed: success, resetAt: reset };
      }),
    read: (key) =>
      guard(async () => {
        const value = await redis.get<unknown>(key);
        return isEntry(value) ? value : null;
      }),
    write: (key, entry, ttlSeconds) =>
      guard(async () => {
        await redis.set(key, entry, { ex: ttlSeconds });
      }),
    // The key and its lifetime are written in one transaction, so a counter can never be left
    // without an expiry, and SET NX never moves an expiry that is already there.
    count: (key, ttlSeconds) =>
      guard(async () => {
        const [, n] = await redis.multi().set(key, 0, { nx: true, ex: ttlSeconds }).incr(key).exec<[unknown, number]>();
        return n;
      }),
    counts: (keys) =>
      guard(async () => {
        const values = await redis.mget<(number | string | null)[]>(...keys);
        return values.map((value) => (typeof value === 'number' ? value : Number(value) || 0));
      }),
    peek: (key) =>
      guard(async () => {
        const value = await redis.get<number | string | null>(key);
        return typeof value === 'number' ? value : Number(value) || 0;
      }),
    save: (key, entry, expiresAt) => guard(async () => (await redis.set(key, entry, { nx: true, exat: expiresAt })) === 'OK'),
  };
}

// Local development without Redis: every request passes, nothing is cached, nothing is counted.
export function skippedStore(): Store {
  return {
    allow: async () => ({ allowed: true, resetAt: 0 }),
    read: async () => null,
    write: async () => {},
    count: async () => 0,
    counts: async (keys) => keys.map(() => 0),
    peek: async () => 0,
    save: async () => false,
  };
}
