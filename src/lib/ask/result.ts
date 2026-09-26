// What the three on-demand endpoints share: the result a handler returns, the one line a failed
// request logs, and the JSON response a result becomes. None of it sees the question or the
// visitor's address.
import { errorType } from './errors.ts';
import { retryAfter, StoreError } from './redis.ts';

export interface EndpointResult {
  status: number;
  body: Record<string, unknown>;
  // Headers beyond the fixed ones, such as a 429's Retry-After.
  headers?: Record<string, string>;
}

export interface LogEntry {
  status: number;
  errorType: string | null;
  requestId: string | null;
  latencyMs: number;
}

export type Done = (status: number, body: Record<string, unknown>, type?: string | null, requestId?: string | null) => EndpointResult;

// How a handler finishes: every outcome is logged with the time since the request started.
export function finisher(log: (entry: LogEntry) => void, now: () => number, start: number): Done {
  return (status, body, type = null, requestId = null) => {
    log({ status, errorType: type, requestId, latencyMs: now() - start });
    return { status, body };
  };
}

export function rateLimited(done: Done, resetAt: number, nowMs: number): EndpointResult {
  return { ...done(429, { error: 'rate_limited' }, 'rate_limit'), headers: retryAfter(resetAt, nowMs) };
}

// A store that fails is the service being down; anything else is a fault in this code.
export function failed(done: Done, error: unknown): EndpointResult {
  if (error instanceof StoreError) return done(503, { reason: 'upstream' }, error.name);
  return done(500, { error: 'internal' }, errorType(error));
}

// Only failures are logged, one line each.
export function logFailure(entry: LogEntry): void {
  if (entry.status < 400) return;
  console.warn(JSON.stringify(entry));
}

export async function readBody(request: Request): Promise<unknown> {
  return request.json().catch(() => undefined);
}

export function respond(result: EndpointResult): Response {
  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...result.headers },
  });
}
