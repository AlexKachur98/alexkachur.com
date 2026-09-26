// Sending a question to Alex, only when the visitor clicks to: the token /api/ask adds to an
// answer, and POST /api/questions, which stores the question and the day for 90 days. The token
// proves the question was asked here in the last ten minutes, so nothing that was never asked can
// be stored. Nothing here stores or logs the visitor's address or any hash of it.
import { createHash, createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import type { AskConfig } from './config.ts';
import { errorType } from './errors.ts';
import type { AskResult, LogEntry } from './handler.ts';
import { limitKey, questionKey, sentDayKey } from './keys.ts';
import { readQuestion } from './question.ts';
import { retryAfter, StoreError } from './redis.ts';
import type { Store } from './redis.ts';
import { DAY, keptFor, TTL } from './storage.ts';

// How long after an answer its question can be sent, and how far ahead of this server's clock a
// token's time may be: tokens are minted and checked on different instances of the same host.
export const SEND = { windowSeconds: 600, skewSeconds: 60, dailyCap: 50 } as const;

// What POST /api/questions does, for the /api page and the OpenAPI document alike.
export const SEND_DESCRIPTION = `Sends Alex a question the site could not answer, only when the visitor chooses to send it, using the token /api/ask returned with it. It is kept for ${keptFor(TTL.sentQuestion)}, and no endpoint ever returns it.`;

const TOKEN = /^(\d{1,12})\.([A-Za-z0-9_-]{43})$/;
// Control characters and text-direction controls, which can be pasted into the Ask input and
// could disguise a stored question when it is printed.
const UNPRINTABLE = /[\p{Cc}\p{Bidi_Control}]/u;

// A key for tokens alone, derived from the rate limit's secret so no new secret is needed and that
// secret is never used as it is. The environment is part of it, so a token minted on a preview
// deployment is refused by production.
export function tokenKey(secret: string, env: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, '', `alexkachur.com send-question token v1 ${env}`, 32));
}

function signature(key: Buffer, seconds: number, question: string): string {
  const hash = createHash('sha256').update(question).digest('hex');
  return createHmac('sha256', key).update(`${seconds}.${hash}`).digest('base64url');
}

// The question exactly as asked (trimmed), so only that text can be sent with this token.
export function mintToken(key: Buffer, question: string, nowMs: number): string {
  const seconds = Math.floor(nowMs / 1000);
  return `${seconds}.${signature(key, seconds, question)}`;
}

export function tokenValid(key: Buffer, question: string, token: unknown, nowMs: number): boolean {
  if (typeof token !== 'string') return false;
  const match = TOKEN.exec(token);
  if (!match) return false;
  const seconds = Number(match[1]);
  const given = Buffer.from(match[2]!);
  const expected = Buffer.from(signature(key, seconds, question));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;
  const age = Math.floor(nowMs / 1000) - seconds;
  return age <= SEND.windowSeconds && age >= -SEND.skewSeconds;
}

// Adds the token to a 200 from /api/ask, cached answers and refusals included. It is minted per
// response and never cached. A question /api/questions would refuse gets none, so the page never
// offers to send it.
export function withToken(result: AskResult, body: unknown, config: AskConfig, nowMs: number): AskResult {
  const question = readQuestion(body);
  if (result.status !== 200 || question === null || UNPRINTABLE.test(question) || !config.limitSecret) return result;
  return { ...result, body: { ...result.body, token: mintToken(tokenKey(config.limitSecret, config.env), question, nowMs) } };
}

export interface SendDeps {
  config: AskConfig;
  store: Store | null;
  now?: () => number;
  log: (entry: LogEntry) => void;
}

// The UTC day of a moment, and the second that day started.
function dayOf(nowMs: number): { date: string; start: number } {
  const date = new Date(nowMs).toISOString().slice(0, 10);
  return { date, start: Date.parse(`${date}T00:00:00Z`) / 1000 };
}

export async function handleSend(body: unknown, ip: string, deps: SendDeps): Promise<AskResult> {
  const now = deps.now ?? Date.now;
  const started = now();
  const done = (status: number, result: Record<string, unknown>, type: string | null = null): AskResult => {
    deps.log({ status, errorType: type, requestId: null, latencyMs: now() - started });
    return { status, body: result };
  };

  const question = readQuestion(body);
  if (question === null || UNPRINTABLE.test(question)) {
    return done(400, { error: 'invalid_question' }, 'input');
  }
  const { config, store } = deps;
  // Asking switched off switches sending off with it.
  if (config.cap === 0) return done(503, { reason: 'budget' }, 'cap');
  // Without Redis there is nowhere to keep the question, so a send never pretends it worked.
  if (!store || !config.redis || !config.limitSecret) return done(503, { reason: 'config' }, 'config');
  const token = (body as { token?: unknown }).token;
  if (!tokenValid(tokenKey(config.limitSecret, config.env), question, token, started)) {
    return done(403, { error: 'invalid_token' }, 'token');
  }

  try {
    const allowance = await store.allow(limitKey(config.limitSecret, ip));
    if (!allowance.allowed) return { ...done(429, { error: 'rate_limited' }, 'rate_limit'), headers: retryAfter(allowance.resetAt, now()) };
    // One clock reading for the day's count, the stored date and the expiry, so a send that
    // crosses midnight cannot land in two days.
    const day = dayOf(started);
    const dayKey = sentDayKey(config.env, day.date);
    // A full day opens again at the next UTC midnight.
    if ((await store.peek(dayKey)) >= SEND.dailyCap) return { ...done(429, { error: 'daily_cap' }, 'daily_cap'), headers: retryAfter((day.start + DAY) * 1000, started) };
    // Keyed by the question, so the same question sent again is stored once and its expiry kept.
    const written = await store.save(questionKey(config.env, question), { question, date: day.date }, day.start + TTL.sentQuestion);
    // Counted only when stored, so replaying one token cannot use up the day. Sends of different
    // questions at the same moment can each pass the check above, so the count can end a few over
    // the cap; each of those needed a question of its own asked first.
    if (written) await store.count(dayKey, TTL.sentDay);
    // The same answer whether or not someone sent the question before, so this reveals nothing.
    return done(200, { sent: true });
  } catch (error) {
    if (error instanceof StoreError) return done(503, { reason: 'upstream' }, error.name);
    return done(500, { error: 'internal' }, errorType(error));
  }
}

