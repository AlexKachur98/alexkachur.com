// The Redis side of an ask: the sliding-window rate limit, the answer cache and the two monthly
// counters, behind one small interface so the handler can be tested with a fake.
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

export interface CacheEntry {
  sql: string;
  explanation: string;
}

export interface Store {
  // True while the address is inside its window.
  allow(ip: string): Promise<boolean>;
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

export function redisStore(env: string, credentials: { url: string; token: string }): Store {
  const redis = new Redis({ url: credentials.url, token: credentials.token });
  // Analytics stay off because they would store per-address identifiers.
  const limiter = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(RATE_LIMIT.requests, RATE_LIMIT.window),
    prefix: `ask:${env}:limit`,
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
    allow: (ip) => guard(async () => (await limiter.limit(ip)).success),
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
