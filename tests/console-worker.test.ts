import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildDatabase, dumpSql, loadContent, loadSqlJs, tableRows } from '../scripts/build-db.ts';

// public/console-worker.js is a classic worker script: it runs here as a function with the
// three globals it uses handed in, over the same database the build writes.
const require = createRequire(import.meta.url);
// sql.js exports only its dist files, so the version is read beside the resolved wasm.
const version = (
  JSON.parse(readFileSync(join(dirname(require.resolve('sql.js/dist/sql-wasm.wasm')), '..', 'package.json'), 'utf8')) as {
    version: string;
  }
).version;
const source = readFileSync('public/console-worker.js', 'utf8');
const SQL = await loadSqlJs();
const bytes = buildDatabase(SQL, dumpSql(tableRows(await loadContent())));

interface Reply {
  type: string;
  columns?: string[];
  rows?: unknown[][];
  truncated?: boolean;
  error?: string;
}

interface Shell {
  onmessage: ((event: { data: unknown }) => void) | null;
  postMessage(message: Reply): void;
}

function boot() {
  const posted: Reply[] = [];
  const imported: string[] = [];
  let locateFile: ((file: string) => string) | undefined;
  const self: Shell = { onmessage: null, postMessage: (message) => posted.push(message) };
  const initSqlJs = (config: { locateFile: (file: string) => string }) => {
    locateFile = config.locateFile;
    return loadSqlJs();
  };
  new Function('self', 'importScripts', 'initSqlJs', source)(self, (url: string) => imported.push(url), initSqlJs);
  const send = (data: unknown) => self.onmessage?.({ data });
  return { posted, imported, send, locateFile: () => locateFile };
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  if (!check()) throw new Error('timed out');
}

async function opened() {
  const worker = boot();
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  worker.send({ type: 'open', buffer });
  await until(() => worker.posted.length > 0);
  expect(worker.posted).toEqual([{ type: 'ready' }]);
  worker.posted.length = 0;
  return worker;
}

function exec(worker: Awaited<ReturnType<typeof opened>>, sql: string, limit = 51): Reply[] {
  worker.posted.length = 0;
  worker.send({ type: 'exec', sql, limit });
  return worker.posted;
}

describe('console-worker', () => {
  it('loads sql.js and its wasm from the vendor folder of the installed version', () => {
    const worker = boot();
    expect(worker.imported).toEqual([`/vendor/sql.js-${version}/sql-wasm.js`]);
    expect(worker.locateFile()?.('sql-wasm.wasm')).toBe(`/vendor/sql.js-${version}/sql-wasm.wasm`);
  });

  it('answers open with ready, then a statement with started and the rows', async () => {
    const worker = await opened();
    const replies = exec(worker, 'SELECT name, born FROM pets ORDER BY name');
    expect(replies).toEqual([
      { type: 'started' },
      { type: 'result', columns: ['name', 'born'], rows: [['Moura', 2014], ['Simba', 2024]], truncated: false },
    ]);
  });

  it('steps up to the limit and flags a result that has more', async () => {
    const worker = await opened();
    const series = (count: number) => `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < ${count}) SELECT x FROM n`;
    const more = exec(worker, series(200))[1]!;
    expect(more.rows).toHaveLength(51);
    expect(more.truncated).toBe(true);
    const exact = exec(worker, series(51))[1]!;
    expect(exact.rows).toHaveLength(51);
    expect(exact.truncated).toBe(true);
    const fewer = exec(worker, series(50))[1]!;
    expect(fewer.rows).toHaveLength(50);
    expect(fewer.truncated).toBe(false);
  });

  it('is read-only through the engine, whatever the page sends', async () => {
    const worker = await opened();
    expect(exec(worker, "INSERT INTO facts (key, value) VALUES ('x', 'y')")[1]).toEqual({
      type: 'error',
      error: 'attempt to write a readonly database',
    });
    expect(exec(worker, 'DELETE FROM pets')[1]).toMatchObject({ type: 'error' });
    expect(exec(worker, 'SELECT COUNT(*) AS n FROM pets')[1]).toMatchObject({ rows: [[2]] });
    // A flag pragma takes effect when it is prepared, even under EXPLAIN, which passes the
    // page's prefix guard; the flag is set again before every statement.
    expect(exec(worker, 'EXPLAIN PRAGMA query_only = 0')[1]).toMatchObject({ type: 'result' });
    expect(exec(worker, "WITH x AS (SELECT 1) INSERT INTO facts (key, value) VALUES ('x', 'y')")[1]).toEqual({
      type: 'error',
      error: 'attempt to write a readonly database',
    });
    expect(exec(worker, "SELECT COUNT(*) AS n FROM facts WHERE key = 'x'")[1]).toMatchObject({ rows: [[0]] });
  });

  it('refuses bytes that are not a database at open, not on the first query', async () => {
    const worker = boot();
    worker.send({ type: 'open', buffer: new TextEncoder().encode('<!doctype html><p>not a database</p>').buffer });
    await until(() => worker.posted.length > 0);
    expect(worker.posted).toEqual([{ type: 'error', error: 'file is not a database' }]);
  });

  it('runs the first statement only', async () => {
    const worker = await opened();
    expect(exec(worker, 'SELECT 1 AS a; SELECT 2 AS b')[1]).toEqual({ type: 'result', columns: ['a'], rows: [[1]], truncated: false });
  });

  it('reports SQLite errors as text whether sql.js threw a string or an Error', async () => {
    const worker = await opened();
    expect(exec(worker, '')[1]).toEqual({ type: 'error', error: 'Nothing to prepare' });
    expect(exec(worker, 'SELEC 1')[1]).toEqual({ type: 'error', error: 'near "SELEC": syntax error' });
    expect(exec(worker, 'SELECT nope FROM projects')[1]).toEqual({ type: 'error', error: 'no such column: nope' });
    expect(exec(worker, 'SELECT 1 AS ok')[1]).toMatchObject({ type: 'result', rows: [[1]] });
  });

  it('explains a plan under the same protocol', async () => {
    const worker = await opened();
    const reply = exec(worker, 'EXPLAIN QUERY PLAN SELECT name FROM projects WHERE paid = 1')[1]!;
    expect(reply.type).toBe('result');
    expect(reply.columns).toEqual(['id', 'parent', 'notused', 'detail']);
  });
});
