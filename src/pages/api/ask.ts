import type { APIRoute } from 'astro';
import Anthropic from '@anthropic-ai/sdk';
import { readConfig } from '../../lib/ask/config.ts';
import { openDatabase } from '../../lib/ask/db.ts';
import { env } from '../../lib/ask/env.ts';
import { DEADLINE_MS, handleAsk } from '../../lib/ask/handler.ts';
import type { LogEntry, ModelCall } from '../../lib/ask/handler.ts';
import { withToken } from '../../lib/ask/send.ts';
import { storeFor } from '../../lib/ask/store.ts';

export const prerender = false;

let model: { apiKey: string | undefined; call: ModelCall | null } | undefined;

// Built on the first request and kept while the key is unchanged, so a missing key answers 503
// instead of failing the module load.
function modelFor(apiKey: string | undefined): ModelCall | null {
  if (!model || model.apiKey !== apiKey) {
    let call: ModelCall | null = null;
    if (apiKey) {
      const client = new Anthropic({ apiKey, timeout: 15_000, maxRetries: 1 });
      call = (params, options) => client.messages.parse(params, options);
    }
    model = { apiKey, call };
  }
  return model.call;
}

function log(entry: LogEntry): void {
  if (entry.status < 400) return;
  console.warn(JSON.stringify(entry));
}

export const POST: APIRoute = async ({ request, clientAddress }) => {
  const config = readConfig(env);
  const body: unknown = await request.json().catch(() => undefined);
  const answered = await handleAsk(body, clientAddress, {
    config,
    store: storeFor(config, import.meta.env.DEV),
    model: modelFor(config.apiKey),
    db: await openDatabase(),
    signal: AbortSignal.timeout(DEADLINE_MS),
    log,
  });
  // Every answer carries a token that lets the visitor send the question to Alex for ten minutes.
  const result = withToken(answered, body, config, Date.now());
  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
};
