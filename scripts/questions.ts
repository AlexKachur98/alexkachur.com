// Lists the questions visitors chose to send, read with the Upstash credentials in the local .env:
//   npm run questions
//   npm run questions -- --delete-all
// The second prints the same list, then deletes exactly the keys it printed, so a question sent
// after the list was read is kept for the next review. No endpoint ever returns these questions.
// Runs under Node's type stripping, like build-db.ts.
import { Redis } from '@upstash/redis';
import { readConfig } from '../src/lib/ask/config.ts';
import { isMain } from './is-main.ts';

// The part of the Redis client this script uses, so a test can hand in a fake.
export interface QuestionsRedis {
  scan(cursor: string | number, options: { match: string; count: number }): Promise<[string | number, string[]]>;
  mget<T>(...keys: string[]): Promise<T>;
  del(...keys: string[]): Promise<number>;
}

export interface Listed {
  key: string;
  env: string;
  date: string;
  question: string;
}

const PATTERN = 'ask:*:question:*';
const BATCH = 1000;

// Every question key in every environment. SCAN can return a key twice, so they are deduplicated.
async function keys(redis: QuestionsRedis): Promise<string[]> {
  const found = new Set<string>();
  let cursor: string | number = '0';
  do {
    const [next, batch] = await redis.scan(cursor, { match: PATTERN, count: BATCH });
    for (const key of batch) found.add(key);
    cursor = next;
  } while (String(cursor) !== '0');
  return [...found];
}

export async function listQuestions(redis: QuestionsRedis): Promise<Listed[]> {
  const all = await keys(redis);
  const listed: Listed[] = [];
  for (let i = 0; i < all.length; i += BATCH) {
    const chunk = all.slice(i, i + BATCH);
    const values = await redis.mget<unknown[]>(...chunk);
    chunk.forEach((key, index) => {
      const value = values[index] as { question?: unknown; date?: unknown } | null;
      // A key that expired between the scan and the read has nothing left to show.
      if (!value || typeof value.question !== 'string') return;
      listed.push({ key, env: key.split(':')[1] ?? '', date: typeof value.date === 'string' ? value.date : '', question: value.question });
    });
  }
  return listed.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.key < b.key ? -1 : 1));
}

// A visitor typed these, so anything that could drive the terminal (control characters, direction
// overrides and the like) is printed as a code point instead of being sent to it.
export function printable(text: string): string {
  return text.replace(/\p{C}/gu, (char) => `\\u{${char.codePointAt(0)!.toString(16)}}`);
}

export function format(listed: Listed[]): string {
  if (listed.length === 0) return 'No questions have been sent.';
  return listed.map((entry) => `${entry.date}  ${entry.env}  ${printable(entry.question)}`).join('\n');
}

async function deleteListed(redis: QuestionsRedis, listed: Listed[]): Promise<number> {
  let deleted = 0;
  for (let i = 0; i < listed.length; i += BATCH) {
    const chunk = listed.slice(i, i + BATCH).map((entry) => entry.key);
    if (chunk.length > 0) deleted += await redis.del(...chunk);
  }
  return deleted;
}

export async function main(argv: string[], env: NodeJS.ProcessEnv, redis?: QuestionsRedis): Promise<{ code: number; out: string }> {
  const pair = readConfig((name) => env[name]).redis;
  const client = redis ?? (pair ? (new Redis({ url: pair.url, token: pair.token }) as unknown as QuestionsRedis) : undefined);
  if (!client) return { code: 1, out: 'questions: no Upstash or KV Redis pair in .env' };
  try {
    const listed = await listQuestions(client);
    const lines = [format(listed)];
    if (argv.includes('--delete-all') && listed.length > 0) lines.push(`deleted ${await deleteListed(client, listed)}`);
    return { code: 0, out: lines.join('\n') };
  } catch (error) {
    // Only the kind of failure: the error itself can quote the request, credentials included.
    return { code: 1, out: `questions: Redis failed (${error instanceof Error ? error.name : typeof error})` };
  }
}

if (isMain(import.meta.url)) {
  const { code, out } = await main(process.argv.slice(2), process.env);
  console.log(out);
  process.exitCode = code;
}
