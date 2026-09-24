import { describe, expect, it } from 'vitest';
import { format, listQuestions, main, printable } from '../scripts/questions.ts';
import type { QuestionsRedis } from '../scripts/questions.ts';

// A fake Redis holding sent questions in two environments, answering SCAN a few keys at a time and
// repeating one, as SCAN may.
function fakeRedis(entries: Record<string, unknown>) {
  const data = new Map(Object.entries(entries));
  const deleted: string[][] = [];
  let scans = 0;
  const redis: QuestionsRedis = {
    async scan(cursor, { match }) {
      scans += 1;
      const pattern = new RegExp(`^${match.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
      const keys = [...data.keys()].filter((key) => pattern.test(key));
      const start = Number(cursor);
      const batch = keys.slice(start, start + 2);
      const next = start + 2 >= keys.length ? 0 : start + 2;
      return [String(next), start === 0 && keys[0] ? [...batch, keys[0]] : batch];
    },
    async mget<T>(...keys: string[]) {
      return keys.map((key) => data.get(key) ?? null) as T;
    },
    async del(...keys: string[]) {
      deleted.push(keys);
      let n = 0;
      for (const key of keys) if (data.delete(key)) n += 1;
      return n;
    },
  };
  return { redis, data, deleted, scans: () => scans };
}

const stored = {
  'ask:production:question:bbb': { question: 'Where did Alex grow up?', date: '2026-09-25' },
  'ask:production:question:aaa': { question: 'What is Alex reading?', date: '2026-09-24' },
  'ask:preview:question:ccc': { question: 'Does Alex like cats?', date: '2026-09-24' },
  'ask:production:cache:v3:12345678:ddd': { sql: 'SELECT 1', explanation: 'One.' },
};

describe('npm run questions', () => {
  it('lists every sent question once, oldest first, and nothing else', async () => {
    const { redis } = fakeRedis(stored);
    const listed = await listQuestions(redis);
    expect(listed.map((entry) => [entry.date, entry.env, entry.question])).toEqual([
      ['2026-09-24', 'preview', 'Does Alex like cats?'],
      ['2026-09-24', 'production', 'What is Alex reading?'],
      ['2026-09-25', 'production', 'Where did Alex grow up?'],
    ]);
    expect(format(listed).split('\n')[0]).toBe('2026-09-24  preview  Does Alex like cats?');
  });

  it('prints control and direction characters as code points, never raw', () => {
    const escape = String.fromCharCode(27);
    const shown = printable(`Who${escape}[2J is ${String.fromCharCode(0x202e)}xela?`);
    expect(shown).not.toContain(escape);
    expect(shown).not.toContain(String.fromCharCode(0x202e));
    expect(shown).toContain('u{1b}');
    expect(shown).toContain('u{202e}');
  });

  it('with --delete-all deletes exactly the questions it listed and keeps a later one', async () => {
    const fake = fakeRedis(stored);
    const redis: QuestionsRedis = {
      ...fake.redis,
      // A question sent while the list was being read: the delete must not take it.
      async mget<T>(...keys: string[]) {
        fake.data.set('ask:production:question:eee', { question: 'Sent just now?', date: '2026-09-25' });
        return fake.redis.mget<T>(...keys);
      },
    };
    const { code, out } = await main(['--delete-all'], {}, redis);
    expect(code).toBe(0);
    expect(out).toContain('What is Alex reading?');
    expect(out.split('\n').at(-1)).toBe('deleted 3');
    expect([...fake.data.keys()].sort()).toEqual(['ask:production:cache:v3:12345678:ddd', 'ask:production:question:eee']);
  });

  it('without the flag deletes nothing', async () => {
    const fake = fakeRedis(stored);
    const { code } = await main([], {}, fake.redis);
    expect(code).toBe(0);
    expect(fake.deleted).toEqual([]);
  });

  it('says so when no Redis pair is set, and never prints what a failure quotes', async () => {
    expect(await main([], {})).toEqual({ code: 1, out: 'questions: no Upstash or KV Redis pair in .env' });
    const failing: QuestionsRedis = {
      scan: async () => {
        throw new TypeError('request to https://secret-token@example failed');
      },
      mget: async () => [] as never,
      del: async () => 0,
    };
    const { code, out } = await main([], {}, failing);
    expect(code).toBe(1);
    expect(out).toBe('questions: Redis failed (TypeError)');
  });
});
