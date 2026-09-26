// GET /api/stats as a function over injected pieces (store, clock, build values) so every branch
// can be tested with fakes. One MGET reads both counters; nothing here increments anything.
import type { AskConfig } from './config.ts';
import { counterKeys, monthOf } from './keys.ts';
import { StoreError } from './redis.ts';
import type { Store } from './redis.ts';
import type { EndpointResult } from './result.ts';
import { STATS_CACHE } from './storage.ts';

interface BuildInfo {
  commit: string;
  builtAt: string;
}

export type Stats = {
  questionsThisMonth: number;
  modelCallsThisMonth: number;
  cap: number;
  model: string;
  commit: string;
  builtAt: string;
};

export interface StatsDeps {
  config: AskConfig;
  // null when production has no Redis variables.
  store: Store | null;
  build: BuildInfo;
  now?: () => number;
}

// The CDN keeps a good answer for a minute and may serve it for five more while it refreshes, so
// the footer is usually about a minute behind and at most about six. A failure is never kept.
export const STATS_CACHE_CONTROL = `public, s-maxage=${STATS_CACHE.freshSeconds}, stale-while-revalidate=${STATS_CACHE.staleSeconds}`;

// Any origin may read the counters. A failure keeps the no-store every response starts with.
function result(status: number, body: Stats | { reason: string }): EndpointResult {
  const cache: Record<string, string> = status === 200 ? { 'Cache-Control': STATS_CACHE_CONTROL } : {};
  return { status, body, headers: { ...cache, 'Access-Control-Allow-Origin': '*' } };
}

export async function handleStats({ config, store, build, now = Date.now }: StatsDeps): Promise<EndpointResult> {
  if (!store) return result(503, { reason: 'config' });
  const keys = counterKeys(config.env, monthOf(now()));
  let counts: number[];
  try {
    counts = await store.counts([keys.asked, keys.model]);
  } catch (error) {
    if (error instanceof StoreError) return result(503, { reason: 'upstream' });
    throw error;
  }
  const [questionsThisMonth, modelCallsThisMonth] = counts;
  if (questionsThisMonth === undefined || modelCallsThisMonth === undefined) {
    throw new Error(`stats: expected two counters, got ${counts.length}`);
  }
  return result(200, {
    questionsThisMonth,
    modelCallsThisMonth,
    cap: config.cap,
    model: config.model,
    commit: build.commit,
    builtAt: build.builtAt,
  });
}
