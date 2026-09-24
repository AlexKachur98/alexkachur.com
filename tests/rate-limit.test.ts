import { createHmac } from 'node:crypto';
import { Ratelimit } from '@upstash/ratelimit';
import type { Redis } from '@upstash/redis';
import { describe, expect, it, vi } from 'vitest';
import type { AskConfig } from '../src/lib/ask/config.ts';
import { openDatabase } from '../src/lib/ask/db.ts';
import { handleAsk } from '../src/lib/ask/handler.ts';
import type { AskDeps } from '../src/lib/ask/handler.ts';
import { RATE_LIMIT, redisStore } from '../src/lib/ask/redis.ts';
import type { Store } from '../src/lib/ask/redis.ts';

// The rate limit as Redis sees it: the real store and the real limiter over a fake client that
// records every command. The limiter runs its script with EVALSHA and falls back to EVAL with
// the script's text on NOSCRIPT, so the fake refuses the first and answers the second.

const SECRET = 'test-limit-secret';
const QUESTION = 'Which projects use a language model?';
const db = await openDatabase();

interface Command {
  method: string;
  args: unknown[];
}

function fakeRedis(blocked = false) {
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
    expect(commands.map(({ method }) => method)).toEqual(expect.arrayContaining(['eval', 'get', 'set', 'incr']));
    expect(JSON.stringify(commands)).not.toContain(ip);
    const keys = limiterCalls(commands).flatMap(([keys]) => keys);
    expect(keys).toHaveLength(2);
    // Worked out here rather than by the handler's own function, so an unkeyed hash would fail.
    const hmac = createHmac('sha256', SECRET).update(ip).digest('hex');
    for (const key of keys) expect(key).toMatch(new RegExp(`^ask:test:limit:${hmac}:\\d+$`));
  });

  it('keeps no in-memory cache, so a blocked key still goes to Redis every time', async () => {
    const { commands, redis } = fakeRedis(true);
    const store = redisStore('test', redis);
    expect(await store.allow('key')).toBe(false);
    expect(await store.allow('key')).toBe(false);
    expect(limiterCalls(commands)).toHaveLength(2);

    // The library's default would have answered the second from memory. Its memory of a block ends
    // with the window, so the clock is held to keep both calls inside one.
    const control = fakeRedis(true);
    const cached = new Ratelimit({ redis: control.redis, limiter: Ratelimit.slidingWindow(RATE_LIMIT.requests, RATE_LIMIT.window), prefix: 'control' });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 8, 22, 12, 0, 30));
    try {
      await cached.limit('key');
      await cached.limit('key');
    } finally {
      clock.mockRestore();
    }
    expect(limiterCalls(control.commands)).toHaveLength(1);
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
