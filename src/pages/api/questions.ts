import type { APIRoute } from 'astro';
import { readConfig } from '../../lib/ask/config.ts';
import { env } from '../../lib/ask/env.ts';
import { logFailure, readBody, respond } from '../../lib/ask/result.ts';
import { handleSend } from '../../lib/ask/send.ts';
import { storeFor } from '../../lib/ask/store.ts';

export const prerender = false;

export const POST: APIRoute = async ({ request, clientAddress }) => {
  const config = readConfig(env);
  const body = await readBody(request);
  return respond(await handleSend(body, clientAddress, { config, store: storeFor(config, import.meta.env.DEV), log: logFailure }));
};
