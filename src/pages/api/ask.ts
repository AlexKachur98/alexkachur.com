import type { APIRoute } from 'astro';
import Anthropic from '@anthropic-ai/sdk';
import { MODEL, readConfig } from '../../lib/ask/config.ts';
import { openDatabase } from '../../lib/ask/db.ts';
import { env } from '../../lib/ask/env.ts';
import { DEADLINE_MS, handleAsk } from '../../lib/ask/handler.ts';
import type { ModelCall } from '../../lib/ask/handler.ts';
import { logFailure, readBody, respond } from '../../lib/ask/result.ts';
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
      // No retry inside the SDK: every call has to pass the monthly counter first.
      const client = new Anthropic({ apiKey, timeout: MODEL.timeoutMs, maxRetries: 0 });
      call = (params, options) => client.messages.parse(params, options);
    }
    model = { apiKey, call };
  }
  return model.call;
}

export const POST: APIRoute = async ({ request, clientAddress }) => {
  const config = readConfig(env);
  const body = await readBody(request);
  const answered = await handleAsk(body, clientAddress, {
    config,
    store: storeFor(config, import.meta.env.DEV),
    model: modelFor(config.apiKey),
    db: await openDatabase(),
    signal: AbortSignal.timeout(DEADLINE_MS),
    log: logFailure,
  });
  return respond(withToken(answered, body, config, Date.now()));
};
