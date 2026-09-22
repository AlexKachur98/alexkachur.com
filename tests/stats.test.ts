import { describe, expect, it } from 'vitest';
import type { AskConfig } from '../src/lib/ask/config.ts';
import { counterKeys, monthOf } from '../src/lib/ask/counters.ts';
import { skippedStore, StoreError } from '../src/lib/ask/redis.ts';
import type { Store } from '../src/lib/ask/redis.ts';
import { handleStats, STATS_CACHE_CONTROL } from '../src/lib/ask/stats.ts';

// The same marker convention as the ask handler tests: a leak of the store's failure text into a
// body is one substring search away.
const SECRET = 'SECRET-DETAIL';

const config: AskConfig = { env: 'test', model: 'model-under-test', maxTokens: 512, cap: 2000, apiKey: undefined, redis: null };
const build = { commit: '3f9a2c1', builtAt: '2026-10-02T08:00:00.000Z' };
const now = () => Date.UTC(2026, 8, 22, 12, 0, 0);

type Call = [method: keyof Store, ...args: string[]];

interface FakeStore extends Store {
  calls: Call[];
}

// Only counts is expected; any other command is a bug in the stats path.
function fakeStore(values: Record<string, number> = {}, failure?: Error): FakeStore {
  const unexpected = (method: keyof Store) => async () => {
    throw new Error(`stats must not call ${method}`);
  };
  const store: FakeStore = {
    calls: [],
    allow: unexpected('allow'),
    read: unexpected('read'),
    write: unexpected('write'),
    count: unexpected('count'),
    async counts(keys) {
      store.calls.push(['counts', ...keys]);
      if (failure) throw failure;
      return keys.map((key) => values[key] ?? 0);
    },
  };
  return store;
}

async function stats(store: Store | null, overrides: Partial<AskConfig> = {}) {
  const response = await handleStats({ config: { ...config, ...overrides }, store, build, now });
  return { response, body: (await response.json()) as Record<string, unknown> };
}

describe('handleStats', () => {
  it('reads both counters of the current UTC month with one MGET and never increments', async () => {
    const store = fakeStore({ 'ask:test:asked:2026-09': 143, 'ask:test:model:2026-09': 180 });
    const { response, body } = await stats(store);
    expect(response.status).toBe(200);
    expect(body).toEqual({
      questionsThisMonth: 143,
      modelCallsThisMonth: 180,
      cap: 2000,
      model: 'model-under-test',
      commit: '3f9a2c1',
      builtAt: '2026-10-02T08:00:00.000Z',
    });
    expect(store.calls).toEqual([['counts', 'ask:test:asked:2026-09', 'ask:test:model:2026-09']]);
  });

  it('sets the CDN cache window and the open CORS header on a good answer', async () => {
    const { response } = await stats(fakeStore());
    expect(STATS_CACHE_CONTROL).toBe('public, s-maxage=60, stale-while-revalidate=300');
    expect(response.headers.get('Cache-Control')).toBe(STATS_CACHE_CONTROL);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(response.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
  });

  it('reports a month with no counters yet as zeros, and the same for the development skip', async () => {
    expect((await stats(fakeStore())).body).toMatchObject({ questionsThisMonth: 0, modelCallsThisMonth: 0 });
    expect((await stats(skippedStore())).body).toMatchObject({ questionsThisMonth: 0, modelCallsThisMonth: 0 });
  });

  it('carries the configured cap and model, cap 0 included', async () => {
    const { body } = await stats(fakeStore(), { cap: 0, model: 'other-model', env: 'preview' });
    expect(body).toMatchObject({ cap: 0, model: 'other-model' });
  });

  it('keys the counters by the deployment environment', async () => {
    const store = fakeStore();
    await stats(store, { env: 'preview' });
    expect(store.calls).toEqual([['counts', 'ask:preview:asked:2026-09', 'ask:preview:model:2026-09']]);
  });

  it('answers 503 config, uncached, when production has no Redis variables', async () => {
    const { response, body } = await stats(null);
    expect(response.status).toBe(503);
    expect(body).toEqual({ reason: 'config' });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('answers 503 upstream, uncached, when Redis fails, without the cause', async () => {
    const { response, body } = await stats(fakeStore({}, new StoreError(new Error(SECRET))));
    expect(response.status).toBe(503);
    expect(body).toEqual({ reason: 'upstream' });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(JSON.stringify(body)).not.toContain(SECRET);
  });

  it('lets any other failure through rather than dressing it as upstream', async () => {
    await expect(stats(fakeStore({}, new Error(SECRET)))).rejects.toThrow(SECRET);
  });
});

describe('counter keys', () => {
  it('use the UTC calendar month, so the last second of a month still counts in it', () => {
    expect(monthOf(Date.UTC(2026, 8, 30, 23, 59, 59))).toBe('2026-09');
    expect(monthOf(Date.UTC(2026, 9, 1, 0, 0, 0))).toBe('2026-10');
  });

  it('are the ones the ask handler increments', () => {
    expect(counterKeys('test', '2026-09')).toEqual({ asked: 'ask:test:asked:2026-09', model: 'ask:test:model:2026-09' });
  });
});
