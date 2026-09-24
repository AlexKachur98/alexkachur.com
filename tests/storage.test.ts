import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Redis } from '@upstash/redis';
import { describe, expect, it } from 'vitest';
import { buildDatabase, dumpSql, loadSqlJs, parseContent, readContentFiles } from '../scripts/build-db.ts';
import type { AskConfig } from '../src/lib/ask/config.ts';
import { openDatabase } from '../src/lib/ask/db.ts';
import { handleAsk } from '../src/lib/ask/handler.ts';
import type { AskDeps, ModelCall } from '../src/lib/ask/handler.ts';
import { redisStore } from '../src/lib/ask/redis.ts';
import { handleStats } from '../src/lib/ask/stats.ts';
import { keptFor, LIMITER_KEY_SECONDS, storageRows, stored, TTL } from '../src/lib/ask/storage.ts';

// The storage table must list everything the code stores. The real store runs over a fake Redis
// that keeps its data and the lifetime each key was given; every key written must match a row of
// the table by key and by lifetime, no key may be left without a lifetime, and every row must be
// written by some path.

const db = await openDatabase();
const NOW = Date.UTC(2026, 8, 24, 12, 0, 0);

interface Written {
  key: string;
  seconds: number;
}

function fakeRedis() {
  const data = new Map<string, unknown>();
  // The lifetime a key was given when it was written, in seconds; a key missing here has none.
  const lifetimes = new Map<string, number>();
  const written: Written[] = [];
  const set = (key: string, value: unknown, options: { ex?: number; nx?: boolean } = {}) => {
    if (options.nx && data.has(key)) return null;
    data.set(key, value);
    const seconds = options.ex;
    if (seconds === undefined) lifetimes.delete(key);
    else lifetimes.set(key, seconds);
    written.push({ key, seconds: seconds ?? Number.NaN });
    return 'OK';
  };
  // INCR keeps a key's lifetime, and a key it creates has none.
  const incr = (key: string) => {
    const next = Number(data.get(key) ?? 0) + 1;
    data.set(key, next);
    return next;
  };
  const client = {
    async evalsha() {
      throw new Error('NOSCRIPT No matching script.');
    },
    // The sliding window's script: the first key is the one it writes, with PEXPIRE of two
    // windows and a second, the window being its third argument in milliseconds.
    async eval(_script: string, keys: string[], args: unknown[]) {
      written.push({ key: keys[0]!, seconds: (Number(args[2]) * 2 + 1000) / 1000 });
      return [9, 10];
    },
    async get(key: string) {
      return data.get(key) ?? null;
    },
    async set(key: string, value: unknown, options?: { ex?: number; nx?: boolean }) {
      return set(key, value, options);
    },
    async incr(key: string) {
      return incr(key);
    },
    async mget(...keys: string[]) {
      return keys.map((key) => data.get(key) ?? null);
    },
    multi() {
      const results: unknown[] = [];
      const chain = {
        set(key: string, value: unknown, options?: { ex?: number; nx?: boolean }) {
          results.push(set(key, value, options));
          return chain;
        },
        incr(key: string) {
          results.push(incr(key));
          return chain;
        },
        async exec() {
          return results;
        },
      };
      return chain;
    },
  };
  return { written, data, lifetimes, redis: client as unknown as Redis };
}

const config: AskConfig = {
  env: 'test',
  model: 'm',
  maxTokens: 512,
  cap: 100,
  apiKey: 'k',
  limitSecret: 'test-limit-secret',
  redis: { url: 'u', token: 't' },
};

function deps(redis: Redis, model: ModelCall): AskDeps {
  return { config, store: redisStore('test', redis), model, db, signal: new AbortController().signal, now: () => NOW, log: () => {} };
}

const answers: ModelCall = async () => ({ parsed_output: { sql: 'SELECT name FROM projects', explanation: 'Lists the projects.' }, stop_reason: 'end_turn' });
const refuses: ModelCall = async () => ({ parsed_output: { sql: '', explanation: 'The site has no salary data.' }, stop_reason: 'end_turn' });

function rowsFor(entry: Written) {
  return stored.filter((row) => row.where === 'redis' && row.key.test(entry.key) && row.keep === entry.seconds);
}

describe('the storage table', () => {
  it('lists every key the ask and stats paths write, with the lifetime the code gives it', async () => {
    const { written, data, lifetimes, redis } = fakeRedis();
    expect((await handleAsk({ question: 'Which projects are there?' }, '203.0.113.7', deps(redis, answers))).status).toBe(200);
    expect((await handleAsk({ question: 'Which projects are there?' }, '203.0.113.7', deps(redis, answers))).body.cached).toBe(true);
    expect((await handleAsk({ question: 'What does Alex earn?' }, '203.0.113.7', deps(redis, refuses))).status).toBe(200);
    expect((await handleStats({ config, store: redisStore('test', redis), build: { commit: 'c', builtAt: 'b' }, now: () => NOW })).status).toBe(200);

    expect(written.length).toBeGreaterThan(0);
    for (const entry of written) expect(rowsFor(entry), `${entry.key} kept ${entry.seconds} s`).toHaveLength(1);
    for (const key of data.keys()) expect(lifetimes.has(key), `${key} has no lifetime`).toBe(true);
    const covered = new Set(written.flatMap((entry) => rowsFor(entry)));
    for (const row of stored.filter((candidate) => candidate.where === 'redis')) expect(covered.has(row), row.item).toBe(true);
  });

  it('counts up from one and gives a counter its lifetime once, on the first count', async () => {
    const { written, lifetimes, redis } = fakeRedis();
    const store = redisStore('test', redis);
    const key = 'ask:test:asked:2026-09';
    expect([await store.count(key, TTL.counter), await store.count(key, TTL.counter), await store.count(key, TTL.counter)]).toEqual([1, 2, 3]);
    expect(written.filter((entry) => entry.key === key)).toEqual([{ key, seconds: TTL.counter }]);
    expect(lifetimes.get(key)).toBe(TTL.counter);
  });

  it('takes each lifetime from the constants the code uses', () => {
    expect(storageRows().map((row) => row.kept_for)).toEqual(stored.map((row) => keptFor(row.keep)));
    expect(stored.map((row) => row.keep)).toEqual(expect.arrayContaining([TTL.answer, TTL.refusal, TTL.counter, LIMITER_KEY_SECONDS, null]));
    expect(keptFor(TTL.answer)).toBe('30 days');
    expect(keptFor(TTL.refusal)).toBe('1 day');
    expect(keptFor(LIMITER_KEY_SECONDS)).toBe('2 minutes 1 second');
    expect(keptFor(null)).toBe('until you clear it');
  });

  it('builds exactly these rows, in this order, into the database', async () => {
    const built = new (await loadSqlJs()).Database(buildDatabase(await loadSqlJs(), dumpSql(parseContent(readContentFiles('src/content')))));
    const result = built.exec('SELECT item, kept_for, purpose FROM storage')[0]!;
    built.close();
    expect(result.values.map(([item, kept_for, purpose]) => ({ item, kept_for, purpose }))).toEqual(storageRows());
  });
});

// Every file under a folder, for the checks below that read the source itself.
function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path.split('\\').join('/')];
  });
}

describe('what the source can store', () => {
  it('reaches Redis only through the store module', () => {
    const importers = [...filesUnder('src'), ...filesUnder('scripts'), 'middleware.ts']
      .filter((path) => /\.(ts|astro|mjs)$/.test(path))
      .filter((path) => /['"]@upstash\//.test(readFileSync(path, 'utf8')));
    expect(importers.sort()).toEqual(['src/lib/ask/redis.ts', 'src/lib/ask/store.ts']);
  });

  it('keeps nothing in the browser, and sets no cookie, that the table does not list', () => {
    const sources = [
      ...filesUnder('src'),
      'middleware.ts',
      ...readdirSync('public')
        .filter((name) => name.endsWith('.js'))
        .map((name) => `public/${name}`),
    ].filter((path) => /\.(ts|astro|js)$/.test(path));
    const browserRows = stored.filter((row) => row.where === 'browser');
    let found = 0;
    for (const path of sources) {
      const text = readFileSync(path, 'utf8');
      for (const api of ['sessionStorage', 'document.cookie', 'indexedDB', 'caches.', 'cookies.set', 'Astro.cookies']) {
        expect(text.includes(api), `${path} uses ${api}`).toBe(false);
      }
      expect(/set-cookie/i.test(text), `${path} sets a cookie header`).toBe(false);
      const calls = [...text.matchAll(/localStorage\.(\w+)\(\s*(?:'([^']*)'|"([^"]*)"|(\w+))/g)];
      // Any other use (an alias, a property, a computed key) would go unchecked, so none is allowed.
      expect(calls.length, `${path} uses localStorage other than by a method with a key`).toBe((text.match(/\blocalStorage\b/g) ?? []).length);
      for (const match of calls) {
        const name = match[2] ?? match[3];
        expect(name, `${path}: localStorage.${match[1]} with a key that is not a literal`).toBeDefined();
        expect(browserRows.some((row) => row.key.test(name!)), `${path} stores ${name} in the browser`).toBe(true);
        found += 1;
      }
    }
    expect(found).toBeGreaterThan(0);
  });
});
