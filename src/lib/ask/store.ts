// One Store per process, built on the first request, so a missing variable gives a 503 instead of
// a failed module load. Without Redis, development skips it and warns once; production gets null,
// which each endpoint answers as a configuration failure.
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
      console.warn('ask: no Redis variables in .env; nothing is limited, capped, cached or counted, and questions cannot be sent');
    }
  }
  cached = { key, store };
  return store;
}
