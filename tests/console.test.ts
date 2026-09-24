import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { examples } from '../src/data/examples.ts';
import { createExecutor, guard, renderCell, ROWS, setStatus, sqlTokens, summary, visibleRows } from '../src/scripts/console.ts';
import type { Cell, Result, WorkerLike, WorkerReply } from '../src/scripts/console.ts';
import schema from '../src/generated/schema.json';

// The strings written out here rather than imported, so a typo in the module cannot pass by
// comparing the module to itself.
const GUARD = 'Read-only console: SELECT, WITH and EXPLAIN only.';
const STOPPED = 'query stopped after 3 s';

describe('guard', () => {
  it('lets SELECT, WITH and EXPLAIN through in any case and after whitespace', () => {
    expect(guard('SELECT 1')).toBeNull();
    expect(guard('  select name from pets')).toBeNull();
    expect(guard('\nWITH n(x) AS (SELECT 1) SELECT x FROM n')).toBeNull();
    expect(guard('explain query plan select 1')).toBeNull();
  });

  it('shows the read-only message for anything else, including near misses', () => {
    for (const sql of ['INSERT INTO facts VALUES (1, 2)', 'DROP TABLE projects', 'PRAGMA query_only = 0', 'SELECTX', 'without', '-- note\nSELECT 1', '']) {
      expect(guard(sql), sql).toBe(GUARD);
    }
  });
});

function result(count: number, truncated = false): Result {
  return { columns: ['n'], rows: Array.from({ length: count }, (_, i) => [i + 1] as Cell[]), truncated };
}

describe('truncation', () => {
  it('renders at most 50 rows of the 51 the worker steps and says so', () => {
    expect(ROWS).toBe(50);
    const more = result(ROWS + 1, true);
    expect(visibleRows(more)).toHaveLength(50);
    expect(visibleRows(more).at(-1)).toEqual([50]);
    expect(summary(more)).toBe('showing 50 of more');
  });

  it('counts rows otherwise and names an empty result', () => {
    expect(summary(result(50))).toBe('50 rows');
    expect(visibleRows(result(50))).toHaveLength(50);
    expect(summary(result(12))).toBe('12 rows');
    expect(summary(result(1))).toBe('1 row');
    expect(summary(result(0))).toBe('No rows');
  });
});

describe('status line', () => {
  const source = readFileSync('src/scripts/console.ts', 'utf8');

  it('says "No rows" and writes the rest of the empty-result sentence under the results', () => {
    expect(source).toContain("const EMPTY_NOTE = 'The query ran; the data just does not have that.';");
    expect(source).toContain('note.textContent = EMPTY_NOTE;');
    expect(source).toContain('panel.results.replaceChildren(table, note);');
  });

  it('takes the rest of the sentence away when a run starts and when a run fails', () => {
    const run = source.slice(source.indexOf('async function execute('), source.indexOf('export function run()'));
    const start = run.indexOf('dropNote(panel);');
    expect(start).toBeGreaterThan(-1);
    expect(start).toBeLessThan(run.indexOf('const problem = guard(sql);'));
    const failed = run.slice(run.indexOf('} catch (error) {'));
    const again = failed.indexOf('dropNote(panel);');
    expect(again).toBeGreaterThan(-1);
    expect(again).toBeLessThan(failed.indexOf('setError(panel, failure(error));'));
  });

  it('adds the cached label only when asked for the status a run ends on', () => {
    const status = { textContent: '' };
    const panel = { status, suffix: 'cached' } as unknown as Parameters<typeof setStatus>[0];
    setStatus(panel, 'working');
    expect(status.textContent).toBe('working');
    setStatus(panel, 'loading database, 57 KB');
    expect(status.textContent).toBe('loading database, 57 KB');
    setStatus(panel, 'No rows', true);
    expect(status.textContent).toBe('No rows, cached');
    setStatus(panel, '', true);
    expect(status.textContent).toBe('cached');
  });

  it('asks for it after a result, an error and a refusal, never for working or loading', () => {
    expect(source).toContain('setStatus(panel, summary(result), true);');
    expect(source).toContain("setStatus(panel, '', true);");
    expect(source).toContain("if (state.kind === 'refusal') setStatus(ui, '', true);");
    expect(source).toContain('setStatus(panel, loaded ? WORKING_MESSAGE : loadingMessage());');
    expect(source).toContain('setStatus(ui, WORKING_MESSAGE);');
  });
});

describe('photo_url cell rule', () => {
  it('turns a site image in a photo_url column into a thumbnail with the pets alt text', () => {
    for (const [url, alt] of Object.entries(schema.photoAlt)) {
      expect(renderCell('photo_url', url)).toEqual({ kind: 'image', src: url, alt });
    }
  });

  it('falls back to the file name when the map has no entry', () => {
    expect(renderCell('photo_url', '/images/pets/tigger.webp', {})).toEqual({
      kind: 'image',
      src: '/images/pets/tigger.webp',
      alt: 'tigger',
    });
  });

  it('renders everything else as text, whatever the column is called or the value looks like', () => {
    expect(renderCell('photo_url', 'images/pets/simba.webp')).toEqual({ kind: 'text', text: 'images/pets/simba.webp', empty: false });
    expect(renderCell('avatar', '/images/pets/simba.webp')).toEqual({ kind: 'text', text: '/images/pets/simba.webp', empty: false });
    expect(renderCell('born', 2024)).toEqual({ kind: 'text', text: '2024', empty: false });
    expect(renderCell('year_end', null)).toEqual({ kind: 'text', text: 'NULL', empty: true });
  });
});

describe('link cell rule', () => {
  it('turns a web address in any column into a link showing the address', () => {
    const repo = 'https://github.com/AlexKachur98/alexkachur.com';
    expect(renderCell('repo_url', repo)).toEqual({ kind: 'link', href: repo, text: repo });
    expect(renderCell('value', 'http://example.com/')).toEqual({ kind: 'link', href: 'http://example.com/', text: 'http://example.com/' });
    expect(renderCell('photo_url', 'https://example.com/a.webp')).toEqual({
      kind: 'link',
      href: 'https://example.com/a.webp',
      text: 'https://example.com/a.webp',
    });
  });

  it('turns an email address into a mailto link', () => {
    expect(renderCell('value', 'alexkachur98@gmail.com')).toEqual({
      kind: 'link',
      href: 'mailto:alexkachur98@gmail.com',
      text: 'alexkachur98@gmail.com',
    });
  });

  it('leaves text that only contains or resembles an address alone', () => {
    for (const value of ['see https://example.com for more', 'ftp://example.com', 'https://', 'not an@email', 'a@b', 'alexkachur.com']) {
      expect(renderCell('value', value).kind, value).toBe('text');
    }
  });
});

class FakeWorker implements WorkerLike {
  posted: unknown[] = [];
  transfers: unknown[] = [];
  terminated = false;
  onmessage: ((event: MessageEvent<WorkerReply>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;

  postMessage(message: unknown, transfer?: unknown): void {
    this.posted.push(message);
    this.transfers.push(transfer);
  }

  terminate(): void {
    this.terminated = true;
  }

  reply(data: WorkerReply): void {
    this.onmessage?.({ data } as MessageEvent<WorkerReply>);
  }
}

// Lets the executor's awaits (the load, the open, the queue) settle without real time passing.
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function harness() {
  const workers: FakeWorker[] = [];
  const buffer = new ArrayBuffer(8);
  let loads = 0;
  const executor = createExecutor({
    spawn: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
    load: async () => {
      loads++;
      return buffer;
    },
  });
  return { workers, buffer, executor, loads: () => loads };
}

describe('executor', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('spawns before the load, posts the buffer once, then the statement with a 51-row limit', async () => {
    const { workers, buffer, executor, loads } = harness();
    const pending = executor.run('SELECT 1');
    await flush();
    expect(workers).toHaveLength(1);
    expect(loads()).toBe(1);
    expect(workers[0]!.posted).toEqual([{ type: 'open', buffer }]);
    // A structured clone, never a transfer: the buffer must stay usable for a reopen.
    expect(workers[0]!.transfers).toEqual([undefined]);
    workers[0]!.reply({ type: 'ready' });
    await flush();
    expect(workers[0]!.posted[1]).toEqual({ type: 'exec', sql: 'SELECT 1', limit: ROWS + 1 });
    workers[0]!.reply({ type: 'started' });
    workers[0]!.reply({ type: 'result', columns: ['1'], rows: [[1]], truncated: false });
    await expect(pending).resolves.toEqual({ columns: ['1'], rows: [[1]], truncated: false });
    expect(workers[0]!.terminated).toBe(false);
  });

  it('starts the 3-second timer on "started", never on the load or the open', async () => {
    const { workers, executor } = harness();
    const pending = executor.run('SELECT 1');
    await flush();
    vi.advanceTimersByTime(10_000);
    workers[0]!.reply({ type: 'ready' });
    await flush();
    vi.advanceTimersByTime(10_000);
    expect(workers[0]!.terminated).toBe(false);
    workers[0]!.reply({ type: 'started' });
    vi.advanceTimersByTime(2_999);
    expect(workers[0]!.terminated).toBe(false);
    workers[0]!.reply({ type: 'result', columns: ['1'], rows: [[1]], truncated: false });
    await expect(pending).resolves.toMatchObject({ rows: [[1]] });
    vi.advanceTimersByTime(10_000);
    expect(workers).toHaveLength(1);
  });

  it('on timeout terminates the worker, reports the stop, reopens from the kept buffer and runs the next query there', async () => {
    const { workers, buffer, executor, loads } = harness();
    const runaway = executor.run('WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n) SELECT COUNT(*) FROM n');
    await flush();
    workers[0]!.reply({ type: 'ready' });
    await flush();
    workers[0]!.reply({ type: 'started' });
    vi.advanceTimersByTime(3_000);
    await expect(runaway).rejects.toThrow(STOPPED);
    expect(workers[0]!.terminated).toBe(true);
    await flush();
    expect(workers).toHaveLength(2);
    expect(loads()).toBe(1);
    expect(workers[1]!.posted).toEqual([{ type: 'open', buffer }]);
    expect(workers[1]!.transfers).toEqual([undefined]);
    expect(buffer.byteLength).toBe(8);

    // Anything the dead worker still says is ignored.
    workers[0]!.reply({ type: 'result', columns: ['late'], rows: [[0]], truncated: false });

    const next = executor.run('SELECT 2');
    await flush();
    expect(workers[1]!.posted).toHaveLength(1);
    workers[1]!.reply({ type: 'ready' });
    await flush();
    expect(workers[1]!.posted[1]).toEqual({ type: 'exec', sql: 'SELECT 2', limit: ROWS + 1 });
    workers[1]!.reply({ type: 'started' });
    workers[1]!.reply({ type: 'result', columns: ['2'], rows: [[2]], truncated: false });
    await expect(next).resolves.toEqual({ columns: ['2'], rows: [[2]], truncated: false });
    expect(workers[1]!.terminated).toBe(false);
  });

  it('passes a SQLite error through as the rejection and keeps the worker', async () => {
    const { workers, executor } = harness();
    const bad = executor.run('SELECT nope FROM projects');
    await flush();
    workers[0]!.reply({ type: 'ready' });
    await flush();
    workers[0]!.reply({ type: 'started' });
    workers[0]!.reply({ type: 'error', error: 'no such column: nope' });
    await expect(bad).rejects.toThrow('no such column: nope');
    expect(workers[0]!.terminated).toBe(false);
    const ok = executor.run('SELECT 1');
    await flush();
    expect(workers[0]!.posted).toHaveLength(3);
    workers[0]!.reply({ type: 'started' });
    workers[0]!.reply({ type: 'result', columns: ['1'], rows: [[1]], truncated: false });
    await expect(ok).resolves.toMatchObject({ rows: [[1]] });
  });

  it('runs queries one after another on the same worker', async () => {
    const { workers, executor } = harness();
    const first = executor.run('SELECT 1');
    const second = executor.run('SELECT 2');
    await flush();
    workers[0]!.reply({ type: 'ready' });
    await flush();
    expect(workers[0]!.posted).toHaveLength(2);
    workers[0]!.reply({ type: 'started' });
    workers[0]!.reply({ type: 'result', columns: ['1'], rows: [[1]], truncated: false });
    await expect(first).resolves.toMatchObject({ rows: [[1]] });
    await flush();
    expect(workers[0]!.posted[2]).toEqual({ type: 'exec', sql: 'SELECT 2', limit: ROWS + 1 });
    workers[0]!.reply({ type: 'started' });
    workers[0]!.reply({ type: 'result', columns: ['2'], rows: [[2]], truncated: false });
    await expect(second).resolves.toMatchObject({ rows: [[2]] });
    expect(workers).toHaveLength(1);
  });

  it('reports a worker that fails while the database is still downloading, without an unhandled rejection', async () => {
    const workers: FakeWorker[] = [];
    let release: (buffer: ArrayBuffer) => void = () => undefined;
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const executor = createExecutor({
        spawn: () => {
          const worker = new FakeWorker();
          workers.push(worker);
          return worker;
        },
        load: () => new Promise<ArrayBuffer>((resolve) => (release = resolve)),
      });
      const pending = executor.ready();
      await flush();
      workers[0]!.onerror?.({ message: '' } as ErrorEvent);
      await flush();
      await new Promise((resolve) => setImmediate(resolve));
      release(new ArrayBuffer(8));
      await expect(pending).rejects.toThrow('/console-worker.js');
      expect(workers[0]!.terminated).toBe(true);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('forgets bytes the worker refused and a reopen that failed, so the next query starts afresh', async () => {
    const { workers, executor, loads } = harness();
    const first = executor.run('SELECT 1');
    await flush();
    workers[0]!.reply({ type: 'error', error: 'file is not a database' });
    await expect(first).rejects.toThrow('file is not a database');
    expect(workers[0]!.terminated).toBe(true);
    const second = executor.run('SELECT 1');
    await flush();
    expect(loads()).toBe(2);
    workers[1]!.reply({ type: 'ready' });
    await flush();
    workers[1]!.reply({ type: 'started' });
    vi.advanceTimersByTime(3_000);
    await expect(second).rejects.toThrow(STOPPED);
    await flush();
    expect(workers).toHaveLength(3);
    workers[2]!.reply({ type: 'error', error: 'wasm streaming compile failed' });
    await flush();
    const third = executor.run('SELECT 3');
    await flush();
    expect(workers).toHaveLength(4);
    workers[3]!.reply({ type: 'ready' });
    await flush();
    workers[3]!.reply({ type: 'started' });
    workers[3]!.reply({ type: 'result', columns: ['3'], rows: [[3]], truncated: false });
    await expect(third).resolves.toMatchObject({ rows: [[3]] });
  });

  it('retries the load and the worker after a failed open', async () => {
    const workers: FakeWorker[] = [];
    let attempts = 0;
    const executor = createExecutor({
      spawn: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      },
      load: async () => {
        attempts++;
        if (attempts === 1) throw new Error('404 /data/portfolio.sqlite');
        return new ArrayBuffer(8);
      },
    });
    await expect(executor.ready()).rejects.toThrow('404 /data/portfolio.sqlite');
    expect(workers[0]!.terminated).toBe(true);
    const ready = executor.ready();
    await flush();
    expect(workers).toHaveLength(2);
    workers[1]!.reply({ type: 'ready' });
    await expect(ready).resolves.toBeUndefined();
  });
});

function keywords(sql: string): string[] {
  return sqlTokens(sql)
    .filter((token) => token.keyword)
    .map((token) => token.text);
}

describe('SQL keyword tokens', () => {
  it('picks out the syntax words of the example queries and nothing else', () => {
    expect(keywords(examples[0]!.sql)).toEqual(['SELECT', 'FROM', 'WHERE']);
    // end is the experience column, not the keyword.
    expect(keywords(examples[2]!.sql)).toEqual(['SELECT', 'FROM', 'WHERE', 'IS', 'NOT', 'NULL', 'ORDER', 'BY']);
    expect(keywords(examples[3]!.sql)).toEqual(['SELECT', 'FROM']);
    expect(keywords(examples[4]!.sql)).toEqual(['SELECT', 'AS', 'FROM', 'JOIN', 'ON', 'GROUP', 'BY', 'HAVING', 'ORDER', 'BY', 'DESC']);
    expect(keywords(examples[5]!.sql)).toEqual(['SELECT', 'FROM', 'WHERE']);
    // key is the facts column, not the keyword.
    expect(keywords(examples[7]!.sql)).toEqual(['SELECT', 'FROM', 'WHERE', 'IN']);
  });

  it('matches in any case but leaves a function and a column named after it plain', () => {
    expect(keywords('select kind, count(*) as count from projects group by kind order by count desc')).toEqual([
      'select',
      'as',
      'from',
      'group',
      'by',
      'order',
      'by',
      'desc',
    ]);
  });

  it('colours END only where it closes a CASE, since end is also a column', () => {
    expect(keywords('SELECT title, start, end FROM experience WHERE end IS NULL')).toEqual(['SELECT', 'FROM', 'WHERE', 'IS', 'NULL']);
    expect(keywords("SELECT CASE WHEN end IS NULL THEN 'now' ELSE end END AS until FROM experience")).toEqual([
      'SELECT',
      'CASE',
      'WHEN',
      'IS',
      'NULL',
      'THEN',
      'ELSE',
      'END',
      'AS',
      'FROM',
    ]);
    expect(keywords('SELECT CASE WHEN a THEN CASE WHEN b THEN 1 END END, end FROM t')).toEqual([
      'SELECT',
      'CASE',
      'WHEN',
      'THEN',
      'CASE',
      'WHEN',
      'THEN',
      'END',
      'END',
      'FROM',
    ]);
  });

  it('treats a string, a closing bracket and a bare decimal as the value that END follows', () => {
    const closes = ['SELECT', 'CASE', 'WHEN', 'THEN', 'END', 'FROM'];
    expect(keywords("SELECT CASE WHEN a THEN 'x' END FROM t")).toEqual(closes);
    expect(keywords('SELECT CASE WHEN a THEN COUNT(*) END FROM t')).toEqual(closes);
    expect(keywords('SELECT CASE WHEN a THEN .5 END FROM t')).toEqual(closes);
    expect(keywords('SELECT CASE WHEN (end IS NULL) THEN 1 END FROM t')).toEqual(['SELECT', 'CASE', 'WHEN', 'IS', 'NULL', 'THEN', 'END', 'FROM']);
  });

  it('never colours a table or column name of this database', () => {
    for (const table of schema.tables) {
      for (const name of [table.name, ...table.columns.map((column) => column.name)]) {
        expect(keywords(name), name).toEqual([]);
        expect(keywords(name.toUpperCase()), name).toEqual([]);
      }
    }
  });

  it('leaves strings, quoted names, comments, qualified names and non-ASCII look-alikes plain', () => {
    // SQLite reads the long s and the dotless i as letters of a name, though they upper-case to
    // SELECT and IN.
    for (const sql of ["'It''s FROM here'", '"order"', '`group`', '[select]', '-- from the notes', '/* and */', 't.end', '\u017Felect', '\u0131n']) {
      expect(keywords(sql), sql).toEqual([]);
    }
  });

  it('keeps a keyword inside an unfinished string or comment, or inside a longer name, plain', () => {
    expect(keywords("SELECT x FROM t WHERE a = 'from")).toEqual(['SELECT', 'FROM', 'WHERE']);
    expect(keywords('SELECT 1 /* from')).toEqual(['SELECT']);
    expect(keywords('SELECT "from')).toEqual(['SELECT']);
    expect(keywords('SELECT x from\u00E9')).toEqual(['SELECT']);
  });

  it('gives the SQL back exactly, with no empty token and no two plain runs side by side', () => {
    const samples = [...examples.map((example) => example.sql), "SELECT 'open", 'SELECT 1 /* open', '', 'SELECT\n  1.5e3,\t.5 FROM x'];
    for (const sql of samples) {
      const tokens = sqlTokens(sql);
      expect(tokens.map((token) => token.text).join(''), sql).toBe(sql);
      for (const [index, token] of tokens.entries()) {
        expect(token.text, sql).not.toBe('');
        if (index > 0) expect(token.keyword || tokens[index - 1]!.keyword, sql).toBe(true);
      }
    }
  });
});

describe('Ask SQL rendering', () => {
  const source = readFileSync('src/scripts/console.ts', 'utf8');

  it('builds the SQL an answer shows from nodes, never from an HTML string', () => {
    expect(source).toContain('ui.sql.replaceChildren(...sqlNodes(sql));');
    expect(source).toContain('document.createTextNode(text)');
    expect(source).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML/);
  });

  it('takes the example out of the panel as the first question or chip begins', () => {
    const begin = source.slice(source.indexOf('function begin('), source.indexOf('async function answer('));
    expect(begin).toMatch(/^function begin\(ui: AskUi, question: string\): void \{\n  ui\.example\?\.remove\(\);\n  ui\.example = null;/);
    expect(source).toContain("example: askRoot.querySelector<HTMLElement>('[data-ask-example]'),");
  });

  it("still hands Edit this query the plain SQL, the example's from its own button", () => {
    expect(source).toContain("consoleUi.input.value = sql ?? askUi.sql.textContent ?? '';");
    // Edit is decided before the box check, so the example's button still edits once a question
    // has taken the example off the page.
    const click = source.slice(source.indexOf('export function click('), source.indexOf('function panelOf('));
    expect(click.indexOf("if (button.hasAttribute('data-ask-edit')) {")).toBeGreaterThan(0);
    expect(click.indexOf("if (button.hasAttribute('data-ask-edit')) {")).toBeLessThan(click.indexOf('if (askUi?.box.contains(button)) {'));
    expect(click).toContain('    edit(sql);\n    return;');
    expect(source).toContain("askRoot.querySelector<HTMLElement>('[data-ask-panel] > [data-ask-edit]')");
  });
});
