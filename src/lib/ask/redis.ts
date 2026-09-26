// Redis behind one small interface: the rate limit, the answer cache, the counters and the
// questions visitors send.
import { Ratelimit } from '@upstash/ratelimit';
import type { Redis } from '@upstash/redis';
import { limitPrefix } from './keys.ts';
import { RATE_LIMIT } from './storage.ts';

export interface CacheEntry {
  sql: string;
  explanation: string;
}

export interface SentQuestion {
  question: string;
  date: string;
}

interface Allowance {
  allowed: boolean;
  // Epoch milliseconds; only meaningful when allowed is false.
  resetAt: number;
}

export function retryAfter(resetAtMs: number, nowMs: number): Record<string, string> {
  return { 'Retry-After': String(Math.max(1, Math.ceil((resetAtMs - nowMs) / 1000))) };
}

export interface Store {
  // The key is the handler's keyed hash of the address, never the address itself.
  allow(key: string): Promise<Allowance>;
  read(key: string): Promise<CacheEntry | null>;
  write(key: string, entry: CacheEntry, ttlSeconds: number): Promise<void>;
  // The lifetime is set by the first count and never extended, so a counter expires on its own.
  count(key: string, ttlSeconds: number): Promise<number>;
  release(key: string): Promise<void>;
  // A key never counted reads as 0.
  counts(keys: string[]): Promise<number[]>;
  peek(key: string): Promise<number>;
  // Writes only a new key, expiring at expiresAt in epoch seconds; false when the key was there.
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

// A counter as Redis returns it: a number, its text, or null for a key never incremented.
function counterValue(value: number | string | null): number {
  return typeof value === 'number' ? value : Number(value) || 0;
}

export function redisStore(env: string, redis: Redis): Store {
  // No in-memory cache and no analytics, so nothing derived from an address is kept beyond the
  // key the storage table on /api describes. A timeout of 0 waits for a slow Redis; the default
  // lets the request through after 5 s.
  const limiter = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(RATE_LIMIT.requests, `${RATE_LIMIT.windowSeconds} s`),
    prefix: limitPrefix(env),
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
    release: (key) =>
      guard(async () => {
        await redis.decr(key);
      }),
    counts: (keys) =>
      guard(async () => {
        const values = await redis.mget<(number | string | null)[]>(...keys);
        return values.map(counterValue);
      }),
    peek: (key) => guard(async () => counterValue(await redis.get<number | string | null>(key))),
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
    release: async () => {},
    counts: async (keys) => keys.map(() => 0),
    peek: async () => 0,
    save: async () => false,
  };
}
