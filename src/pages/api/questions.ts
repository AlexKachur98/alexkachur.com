import type { APIRoute } from 'astro';
import { readConfig } from '../../lib/ask/config.ts';
import { env } from '../../lib/ask/env.ts';
import type { LogEntry } from '../../lib/ask/handler.ts';
import { handleSend } from '../../lib/ask/send.ts';
import { storeFor } from '../../lib/ask/store.ts';

export const prerender = false;

function log(entry: LogEntry): void {
  if (entry.status < 400) return;
  console.warn(JSON.stringify(entry));
}

export const POST: APIRoute = async ({ request, clientAddress }) => {
  const config = readConfig(env);
  const body: unknown = await request.json().catch(() => undefined);
  const result = await handleSend(body, clientAddress, { config, store: storeFor(config, import.meta.env.DEV), log });
  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...result.headers },
  });
};
