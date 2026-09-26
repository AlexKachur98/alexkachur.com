import { createHmac } from 'node:crypto';
import { Ratelimit } from '@upstash/ratelimit';
import type { Redis } from '@upstash/redis';
import { describe, expect, it, vi } from 'vitest';
import type { AskConfig } from '../src/lib/ask/config.ts';
import { openDatabase } from '../src/lib/ask/db.ts';
import { handleAsk } from '../src/lib/ask/handler.ts';
import type { AskDeps } from '../src/lib/ask/handler.ts';
import { redisStore } from '../src/lib/ask/redis.ts';
import { RATE_LIMIT, TTL } from '../src/lib/ask/storage.ts';
import type { Store } from '../src/lib/ask/redis.ts';

// The rate limit as Redis sees it: the real store and the real limiter over a fake client that
// records every command. The limiter runs its script with EVALSHA and falls back to EVAL with
// the script's text on NOSCRIPT, so the fake refuses the first and answers the second, after a
// delay when one is given.

const SECRET = 'test-limit-secret';
const QUESTION = 'Which projects use a language model?';
const db = await openDatabase();

interface Command {
  method: string;
  args: unknown[];
}

function fakeRedis(blocked = false, delayMs = 0) {
  const commands: Command[] = [];
  const scripts: string[] = [];
  const record = (method: string, args: unknown[]) => commands.push({ method, args });
  const client = {
    async evalsha(hash: string, keys: string[], args: unknown[]) {
      record('evalsha', [hash, keys, args]);
      throw new Error('NOSCRIPT No matching script.');
    },
    async eval(script: string, keys: string[], args: unknown[]) {
      record('eval', [keys, args]);
      scripts.push(script);
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      return blocked ? [-1, RATE_LIMIT.requests] : [RATE_LIMIT.requests - 1, RATE_LIMIT.requests];
    },
    async get(key: string) {
      record('get', [key]);
      return null;
    },
    async set(key: string, value: unknown, options: unknown) {
      record('set', [key, value, options]);
      return 'OK';
    },
    async incr(key: string) {
      record('incr', [key]);
      return 1;
    },
    async expire(key: string, seconds: number) {
      record('expire', [key, seconds]);
      return 1;
    },
    multi() {
      const queued: Command[] = [];
      const chain = {
        set(key: string, value: unknown, options: unknown) {
          queued.push({ method: 'set', args: [key, value, options] });
          return chain;
        },
        incr(key: string) {
          queued.push({ method: 'incr', args: [key] });
          return chain;
        },
        async exec() {
          record('multi', [queued]);
          return queued.map(({ method }) => (method === 'incr' ? 1 : 'OK'));
        },
      };
      return chain;
    },
  };
  return { commands, scripts, redis: client as unknown as Redis };
}

const limiterCalls = (commands: Command[]) => commands.filter(({ method }) => method === 'eval').map(({ args }) => args as [string[], unknown[]]);

function deps(store: Store): AskDeps {
  const config: AskConfig = { env: 'test', model: 'm', maxTokens: 512, cap: 100, apiKey: 'k', limitSecret: SECRET, redis: { url: 'u', token: 't' } };
  return {
    config,
    store,
    model: async () => ({ parsed_output: { sql: 'SELECT name FROM projects', explanation: 'Lists the project names.' }, stop_reason: 'end_turn' }),
    db,
    signal: new AbortController().signal,
    log: () => {},
  };
}

describe('the rate limit in Redis', () => {
  it.each(['203.0.113.7', '2001:db8::7'])('writes no key or argument that contains the address %s', async (ip) => {
    const { commands, redis } = fakeRedis();
    const result = await handleAsk({ question: QUESTION }, ip, deps(redisStore('test', redis)));
    expect(result.status).toBe(200);
    expect(commands.map(({ method }) => method)).toEqual(expect.arrayContaining(['eval', 'get', 'set', 'multi']));
    expect(JSON.stringify(commands)).not.toContain(ip);
    const keys = limiterCalls(commands).flatMap(([keys]) => keys);
    expect(keys).toHaveLength(2);
    // Worked out here rather than by the handler's own function, so an unkeyed hash would fail.
    const hmac = createHmac('sha256', SECRET).update(ip).digest('hex');
    for (const key of keys) expect(key).toMatch(new RegExp(`^ask:test:limit:${hmac}:\\d+$`));
  });

  it('answers a blocked address with 429 and a Retry-After inside the window', async () => {
    const { redis } = fakeRedis(true);
    const result = await handleAsk({ question: QUESTION }, '203.0.113.7', deps(redisStore('test', redis)));
    expect(result.status).toBe(429);
    const seconds = Number(result.headers?.['Retry-After']);
    expect(seconds).toBeGreaterThanOrEqual(1);
    expect(seconds).toBeLessThanOrEqual(RATE_LIMIT.windowSeconds);
  });

  it('keeps no in-memory cache, so a blocked key still goes to Redis every time', async () => {
    const { commands, redis } = fakeRedis(true);
    const store = redisStore('test', redis);
    expect(await store.allow('key')).toMatchObject({ allowed: false });
    expect(await store.allow('key')).toMatchObject({ allowed: false });
    expect(limiterCalls(commands)).toHaveLength(2);

    // The library's default would have answered the second from memory. Its memory of a block ends
    // with the window, so the clock is held to keep both calls inside one.
    const control = fakeRedis(true);
    const cached = new Ratelimit({ redis: control.redis, limiter: Ratelimit.slidingWindow(RATE_LIMIT.requests, `${RATE_LIMIT.windowSeconds} s`), prefix: 'control' });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 8, 22, 12, 0, 30));
    try {
      await cached.limit('key');
      await cached.limit('key');
    } finally {
      clock.mockRestore();
    }
    expect(limiterCalls(control.commands)).toHaveLength(1);
  });

  it('waits for a slow Redis instead of letting the request through', async () => {
    vi.useFakeTimers();
    try {
      const { redis } = fakeRedis(true, 6_000);
      const answer = redisStore('test', redis).allow('key');
      // The library's default gives up on Redis after 5 s and lets the request through.
      const control = fakeRedis(true, 6_000);
      const fallback = new Ratelimit({ redis: control.redis, limiter: Ratelimit.slidingWindow(RATE_LIMIT.requests, `${RATE_LIMIT.windowSeconds} s`), prefix: 'control', ephemeralCache: false });
      const passed = fallback.limit('key');
      await vi.advanceTimersByTimeAsync(6_000);
      expect(await answer).toMatchObject({ allowed: false });
      expect(await passed).toMatchObject({ success: true, reason: 'timeout' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('counts in one transaction that gives a new counter its lifetime and never moves it', async () => {
    const { commands, redis } = fakeRedis();
    await redisStore('test', redis).count('ask:test:asked:2026-09', TTL.counter);
    const multi = commands.filter(({ method }) => method === 'multi');
    expect(multi).toHaveLength(1);
    expect(multi[0]!.args[0]).toEqual([
      { method: 'set', args: ['ask:test:asked:2026-09', 0, { nx: true, ex: TTL.counter }] },
      { method: 'incr', args: ['ask:test:asked:2026-09'] },
    ]);
    expect(commands.map(({ method }) => method)).not.toContain('expire');
  });

  it("lets each key expire with the sliding window's two windows and a second: two minutes and one second", async () => {
    const { commands, scripts, redis } = fakeRedis();
    await redisStore('test', redis).allow('key');
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toMatch(/local window\s*=\s*ARGV\[3\]/);
    expect(scripts[0]).toMatch(/redis\.call\("PEXPIRE", currentKey, window \* 2 \+ 1000\)/);
    const [[, args]] = limiterCalls(commands);
    expect(Number(args![2]) * 2 + 1000).toBe(121_000);
  });
});
