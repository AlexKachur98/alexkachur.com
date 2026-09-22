import type { APIRoute } from 'astro';
import { getSecret } from 'astro:env/server';
import Anthropic from '@anthropic-ai/sdk';
import { readConfig } from '../../lib/ask/config.ts';
import type { AskConfig } from '../../lib/ask/config.ts';
import { openDatabase } from '../../lib/ask/db.ts';
import { DEADLINE_MS, handleAsk } from '../../lib/ask/handler.ts';
import type { LogEntry, ModelCall } from '../../lib/ask/handler.ts';
import { redisStore, skippedStore } from '../../lib/ask/redis.ts';
import type { Store } from '../../lib/ask/redis.ts';

export const prerender = false;

// Vercel puts every variable in process.env; astro dev keeps .env in its own loader, which
// getSecret reads. Nothing is read from import.meta.env, which would be inlined at build.
const env = (name: string): string | undefined => process.env[name] ?? (import.meta.env.DEV ? getSecret(name) : undefined);

interface Clients {
  key: string;
  store: Store | null;
  model: ModelCall | null;
}

let clients: Clients | undefined;
let warned = false;

// Built on the first request and kept while the variables are unchanged, so a missing variable
// answers 503 instead of failing the module load.
function clientsFor(config: AskConfig): Clients {
  const key = JSON.stringify([config.env, config.apiKey, config.redis]);
  if (clients?.key === key) return clients;
  let store: Store | null = null;
  if (config.redis) {
    store = redisStore(config.env, config.redis);
  } else if (import.meta.env.DEV) {
    store = skippedStore();
    if (!warned) {
      warned = true;
      console.warn('ask: no Redis variables in .env, so the rate limit, the monthly cap and the cache are skipped');
    }
  }
  let model: ModelCall | null = null;
  if (config.apiKey) {
    const client = new Anthropic({ apiKey: config.apiKey, timeout: 15_000, maxRetries: 1 });
    model = (params, options) => client.messages.parse(params, options);
  }
  clients = { key, store, model };
  return clients;
}

function log(entry: LogEntry): void {
  if (entry.status < 400) return;
  console.warn(JSON.stringify(entry));
}

export const POST: APIRoute = async ({ request, clientAddress }) => {
  const config = readConfig(env);
  const { store, model } = clientsFor(config);
  const body: unknown = await request.json().catch(() => undefined);
  const result = await handleAsk(body, clientAddress, {
    config,
    store,
    model,
    db: await openDatabase(),
    signal: AbortSignal.timeout(DEADLINE_MS),
    log,
  });
  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
};
