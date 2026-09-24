// Everything the site stores, in one place: the lifetimes the code uses and the rows of the
// storage table, built from those same numbers, so the table on /api and the answer to "What does
// this site store about me?" cannot disagree with the code. No imports, so scripts/build-db.ts can
// load it without the SDK. tests/storage.test.ts fails if the code stores anything not listed here.

export const DAY = 86_400;

// A sent question is kept from the start of the day it was sent, so its expiry shows the day and
// not the second; the day's count only has to outlive its own day.
export const TTL = { counter: 40 * DAY, answer: 30 * DAY, refusal: DAY, sentQuestion: 90 * DAY, sentDay: 2 * DAY } as const;

export const RATE_LIMIT = { requests: 10, windowSeconds: 60 } as const;

// The sliding window sets each key to expire two windows and a second after it is written.
export const LIMITER_KEY_SECONDS = 2 * RATE_LIMIT.windowSeconds + 1;

export interface Stored {
  item: string;
  // Seconds, or null for what the visitor's browser keeps until it is cleared.
  keep: number | null;
  purpose: string;
  where: 'redis' | 'browser';
  // The keys the row covers: a Redis key pattern, or the name the browser stores it under.
  key: RegExp;
}

const CACHE_KEY = /^ask:[a-z]+:cache:v\d+:[0-9a-f]{8}:[0-9a-f]{64}$/;

export const stored: readonly Stored[] = [
  {
    item: "The SQL and the model's one-line explanation for a question, which can repeat words from it, under a SHA-256 hash of the question",
    keep: TTL.answer,
    purpose: 'Repeat questions are answered from the cache, free',
    where: 'redis',
    key: CACHE_KEY,
  },
  {
    item: "The model's reason a question cannot be answered, which can repeat words from it, under a SHA-256 hash of the question",
    keep: TTL.refusal,
    purpose: 'The same, for questions the site cannot answer',
    where: 'redis',
    key: CACHE_KEY,
  },
  {
    item: 'A counter keyed by a scrambled form of your address',
    keep: LIMITER_KEY_SECONDS,
    purpose: 'The rate limit, for questions and sent questions alike',
    where: 'redis',
    key: /^ask:[a-z]+:limit:[0-9a-f]{64}:\d+$/,
  },
  {
    item: 'Two monthly totals: questions answered and model calls',
    keep: TTL.counter,
    purpose: 'The footer and the monthly cap',
    where: 'redis',
    key: /^ask:[a-z]+:(asked|model):\d{4}-\d{2}$/,
  },
  {
    item: 'A question you chose to send to Alex, and the day you sent it',
    keep: TTL.sentQuestion,
    purpose: 'So Alex can add what is missing',
    where: 'redis',
    key: /^ask:[a-z]+:question:[0-9a-f]{64}$/,
  },
  {
    item: 'The number of questions sent today',
    keep: TTL.sentDay,
    purpose: 'The daily cap on sent questions',
    where: 'redis',
    key: /^ask:[a-z]+:sent:\d{4}-\d{2}-\d{2}$/,
  },
  {
    item: 'Your light or dark theme choice, in your own browser, never sent to this site',
    keep: null,
    purpose: 'Keeps the theme you picked across pages',
    where: 'browser',
    key: /^theme$/,
  },
];

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;

// "30 days", "2 minutes 1 second", or "until you clear it" for what the browser keeps.
export function keptFor(seconds: number | null): string {
  if (seconds === null) return 'until you clear it';
  if (seconds % DAY === 0) return plural(seconds / DAY, 'day');
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return [minutes > 0 ? plural(minutes, 'minute') : '', rest > 0 ? plural(rest, 'second') : ''].filter(Boolean).join(' ');
}

export function storageRows(): { item: string; kept_for: string; purpose: string }[] {
  return stored.map(({ item, keep, purpose }) => ({ item, kept_for: keptFor(keep), purpose }));
}
