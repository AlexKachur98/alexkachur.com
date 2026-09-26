// The Redis keys the endpoints write, beside the storage table whose patterns they must match.
// Each starts with the deployment environment, so a preview never touches production's data. The
// answer cache's key also carries the prompt version, so the handler builds it.
import { createHash, createHmac } from 'node:crypto';
import { normaliseQuestion } from './normalise.ts';

// The rate limiter's key for an address. A plain hash of an IPv4 address can be reversed by
// hashing every address in turn; keyed with a secret, the stored key cannot be matched back to
// an address without the secret. The storage table's "scrambled form of your address" relies on
// this, so a change here changes that row.
export function limitKey(secret: string, ip: string): string {
  return createHmac('sha256', secret).update(ip).digest('hex');
}

export function limitPrefix(env: string): string {
  return `ask:${env}:limit`;
}

export function monthOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 7);
}

// The two monthly counters that /api/ask increments and /api/stats reads, one set per UTC
// calendar month.
export function counterKeys(env: string, month: string): { asked: string; model: string } {
  return { asked: `ask:${env}:asked:${month}`, model: `ask:${env}:model:${month}` };
}

// How many questions were sent on a UTC day, for the daily cap.
export function sentDayKey(env: string, date: string): string {
  return `ask:${env}:sent:${date}`;
}

// A question's fingerprint: its normalised text hashed, so two wordings that differ only in case,
// spacing or closing punctuation share it.
export function questionDigest(question: string): string {
  return createHash('sha256').update(normaliseQuestion(question)).digest('hex');
}

// A sent question, keyed by its fingerprint, so the same question sent twice is stored once.
export function questionKey(env: string, question: string): string {
  return `ask:${env}:question:${questionDigest(question)}`;
}
