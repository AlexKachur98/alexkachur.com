// The Redis side of an ask: the sliding-window rate limit, the answer cache and the two monthly
// counters, behind one small interface so the handler can be tested with a fake.
import { Ratelimit } from '@upstash/ratelimit';
import type { Redis } from '@upstash/redis';

export interface CacheEntry {
  sql: string;
  explanation: string;
}

export interface Store {
  // True while the key is inside its window. The key is the handler's keyed hash of the address,
  // never the address itself.
  allow(key: string): Promise<boolean>;
  read(key: string): Promise<CacheEntry | null>;
  write(key: string, entry: CacheEntry, ttlSeconds: number): Promise<void>;
  // INCR; the first call on a key also sets its TTL, so a month's counter expires on its own.
  count(key: string, ttlSeconds: number): Promise<number>;
  // MGET of counters, one number per key; a key never incremented reads as 0.
  counts(keys: string[]): Promise<number[]>;
}

// Wraps any Redis failure so the handler can answer 503 upstream without echoing the cause.
export class StoreError extends Error {
  constructor(cause: unknown) {
    super('redis command failed', { cause });
    this.name = 'StoreError';
  }
}

export const RATE_LIMIT = { requests: 10, window: '1 m' } as const;

function isEntry(value: unknown): value is CacheEntry {
  if (value === null || typeof value !== 'object') return false;
  const entry = value as Partial<CacheEntry>;
  return typeof entry.sql === 'string' && typeof entry.explanation === 'string';
}

// The client comes from the caller, so a test can hand in a fake and see every key written.
export function redisStore(env: string, redis: Redis): Store {
  // With the sliding window each key expires two windows and a second after it is first set, and
  // with no in-memory cache the limiter keeps no key in the function's memory between requests.
  // Analytics stay off because they would store per-address identifiers. The What is stored list
  // on /api tells visitors the rate limit keeps a counter keyed by a scrambled form of their
  // address for about two minutes; that line rests on this window, on the cache being off and on
  // the handler's limitKey, so a change to any of them changes the line.
  const limiter = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(RATE_LIMIT.requests, RATE_LIMIT.window),
    prefix: `ask:${env}:limit`,
    ephemeralCache: false,
    analytics: false,
  });
  const guard = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      throw new StoreError(error);
    }
  };
  return {
    allow: (key) => guard(async () => (await limiter.limit(key)).success),
    read: (key) =>
      guard(async () => {
        const value = await redis.get<unknown>(key);
        return isEntry(value) ? value : null;
      }),
    write: (key, entry, ttlSeconds) =>
      guard(async () => {
        await redis.set(key, entry, { ex: ttlSeconds });
      }),
    count: (key, ttlSeconds) =>
      guard(async () => {
        const n = await redis.incr(key);
        if (n === 1) await redis.expire(key, ttlSeconds);
        return n;
      }),
    counts: (keys) =>
      guard(async () => {
        const values = await redis.mget<(number | string | null)[]>(...keys);
        return values.map((value) => (typeof value === 'number' ? value : Number(value) || 0));
      }),
  };
}

// Local development without Redis: every request passes, nothing is cached, nothing is counted.
export function skippedStore(): Store {
  return {
    allow: async () => true,
    read: async () => null,
    write: async () => {},
    count: async () => 0,
    counts: async (keys) => keys.map(() => 0),
  };
}
