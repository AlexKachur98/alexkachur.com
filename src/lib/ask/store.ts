// One Store for both on-demand endpoints, built on the first request and kept while the Redis
// pair is unchanged, so a missing variable answers 503 instead of failing the module load.
// Without the pair, development skips Redis (nothing limited, cached or counted) and says so
// once per process; production gets null, which each endpoint answers as a configuration failure.
import { Redis } from '@upstash/redis';
import type { AskConfig } from './config.ts';
import { redisStore, skippedStore } from './redis.ts';
import type { Store } from './redis.ts';

let cached: { key: string; store: Store | null } | undefined;
let warned = false;

export function storeFor(config: AskConfig, dev: boolean): Store | null {
  const key = JSON.stringify([config.env, config.redis]);
  if (cached?.key === key) return cached.store;
  let store: Store | null = null;
  if (config.redis) {
    store = redisStore(config.env, new Redis({ url: config.redis.url, token: config.redis.token }));
  } else if (dev) {
    store = skippedStore();
    if (!warned) {
      warned = true;
      console.warn('ask: no Redis variables in .env, so the rate limit, the monthly cap, the cache and the counters are skipped');
    }
  }
  cached = { key, store };
  return store;
}
