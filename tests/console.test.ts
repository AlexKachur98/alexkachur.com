import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { examples } from '../src/data/examples.ts';
import { clearable, clearConsole, createExecutor, guard, markOverflow, onScreen, renderCell, ROWS, scrollToShow, setStatus, sqlTokens, summary, visibleRows } from '../src/scripts/console.ts';
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
    expect(renderCell('photo_url', '/images/pets/tigger.webp')).toEqual({
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

  it("records the example's height, then takes it out of the panel, as the first question or chip begins", () => {
    const begin = source.slice(source.indexOf('function begin('), source.indexOf('async function answer('));
    expect(begin).toMatch(/^function begin\(ui: AskUi, question: string\): void \{\n  if \(ui\.example\) \{\n/);
    // The height is read while the example is still there to measure.
    const held = begin.indexOf("ui.root.style.setProperty('--example-height', ");
    expect(held).toBeGreaterThan(0);
    expect(held).toBeLessThan(begin.indexOf('ui.example.remove();'));
    expect(source).toContain("example: askRoot.querySelector<HTMLElement>('[data-ask-example]'),");
  });

  // The hold is only for the pane beside the form: under the form the example never shows, and
  // an answer there grows from nothing.
  it("holds the pane at the example's height only beside the form", () => {
    const style = readFileSync('src/components/AskBox.astro', 'utf8');
    const wide = style.indexOf('@media (min-width: 1200px)');
    expect(wide).toBeGreaterThan(0);
    expect(style.slice(wide)).toMatch(/\.ask-split \.ask-panel \{[^}]*min-height: var\(--example-height, auto\);/);
    expect(style.slice(0, wide)).not.toContain('--example-height');
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

describe('results box', () => {
  const source = readFileSync('src/scripts/console.ts', 'utf8');

  it('starts each table at its first row and column, in either panel', () => {
    const paint = source.slice(source.indexOf('function paint('), source.indexOf('function dropNote('));
    const reset = paint.indexOf('panel.results.scrollTo(0, 0);');
    expect(reset).toBeGreaterThan(paint.indexOf('panel.results.replaceChildren(table);'));
    expect(reset).toBeLessThan(paint.indexOf('panel.results.tabIndex = 0;'));
  });

  it('shows the scroll words while a capped box holds more than it shows, either way, wherever it is scrolled to', () => {
    const cue = { hidden: true };
    const fits = { scrollWidth: 414, clientWidth: 414 };
    markOverflow({ scrollHeight: 804, clientHeight: 400, ...fits }, cue, true);
    expect(cue.hidden).toBe(false);
    // A table wider than the pane, such as a cut web address, scrolls sideways.
    markOverflow({ scrollHeight: 93, clientHeight: 93, scrollWidth: 489, clientWidth: 414 }, cue, true);
    expect(cue.hidden).toBe(false);
    for (const [scrollHeight, clientHeight] of [[400, 400], [401, 400], [0, 0]] as const) {
      markOverflow({ scrollHeight, clientHeight, ...fits }, cue, true);
      expect(cue.hidden, `${scrollHeight} in ${clientHeight}`).toBe(true);
    }
    markOverflow({ scrollHeight: 93, clientHeight: 93, scrollWidth: 415, clientWidth: 414 }, cue, true);
    expect(cue.hidden).toBe(true);
    // Under the form the box grows instead, and a phone's pane has no room for the words.
    markOverflow({ scrollHeight: 93, clientHeight: 93, scrollWidth: 489, clientWidth: 311 }, cue, false);
    expect(cue.hidden).toBe(true);
  });

  it('hides the scroll words as a question begins and checks them after each answer and resize', () => {
    const begin = source.slice(source.indexOf('function begin('), source.indexOf('async function answer('));
    expect(begin).toContain('ui.scrollCue.hidden = true;');
    const answer = source.slice(source.indexOf('async function answer('), source.indexOf('// A capped results box'));
    expect(answer.indexOf('markOverflow(ui.results, ui.scrollCue, capped(ui.results));')).toBeGreaterThan(answer.indexOf('await execute(ui, sql);'));
    expect(source.slice(source.indexOf('export function init('))).toMatch(/new ResizeObserver\(\(\) => markOverflow\(ui\.results, ui\.scrollCue, capped\(ui\.results\)\)\)/);
    // Scrolling never changes the words, so nothing listens for it.
    expect(source).not.toMatch(/addEventListener\('scroll'/);
  });

  // The Ask results scroll inside a box only beside the form, on a mouse or trackpad and a window
  // tall enough; the raw console and everything else keep growing.
  it('caps the Ask results only in the wide, tall, fine-pointer layout', () => {
    expect(readFileSync('src/styles/console.css', 'utf8')).not.toMatch(/max-height/);
    const style = readFileSync('src/components/AskBox.astro', 'utf8');
    const cap = style.indexOf('max-height: 25rem;');
    expect(cap).toBeGreaterThan(0);
    expect(style.lastIndexOf('max-height')).toBe(style.indexOf('max-height'));
    let from = 0;
    for (const rule of ['@media (min-width: 1200px)', '@supports (grid-template-columns: subgrid)', '@media (min-height: 42.5rem) and (hover: hover) and (pointer: fine)']) {
      const at = style.lastIndexOf(rule, cap);
      expect(at, rule).toBeGreaterThan(from);
      from = at;
    }
    // Nested: both media rules, the supports rule and the results rule are all still open at the cap.
    const inside = style.slice(style.lastIndexOf('@media (min-width: 1200px)', cap), cap);
    expect(inside.split('{').length - inside.split('}').length).toBe(4);
  });
});

describe('bringing the answer into sight', () => {
  const source = readFileSync('src/scripts/console.ts', 'utf8');
  // The visible band on a 375x667 phone, less a 16px margin at each edge.
  const sight = { top: 16, bottom: 651 };

  it('scrolls nothing for a box already in sight', () => {
    expect(scrollToShow({ top: 100, bottom: 200 }, sight)).toBe(0);
    expect(scrollToShow({ top: 16, bottom: 651 }, sight)).toBe(0);
  });

  it('lifts a box below the screen just far enough to show all of it', () => {
    expect(scrollToShow({ top: 722, bottom: 783 }, sight)).toBe(132);
    expect(scrollToShow({ top: 600, bottom: 652 }, sight)).toBe(1);
  });

  it('brings a box above the screen, or one taller than it, to its top', () => {
    expect(scrollToShow({ top: -51, bottom: 10 }, sight)).toBe(-67);
    expect(scrollToShow({ top: 300, bottom: 2300 }, sight)).toBe(284);
    expect(scrollToShow({ top: 16, bottom: 2300 }, sight)).toBe(0);
  });

  // A 375x667 phone zoomed to 1.8, so the visual viewport is 370px tall, and scrolled so that it
  // starts 296px down a layout viewport that is itself 81px down the page: the input is 542.8px down
  // the page and so 165.8px down the screen, whichever viewport the browser measures its box from.
  it('places a box on screen the same whichever viewport the browser measures it from', () => {
    const fromLayout = onScreen({ top: 461.8, bottom: 501.8 }, -81, 377);
    const fromVisual = onScreen({ top: 165.8, bottom: 205.8 }, -377, 377);
    for (const box of [fromLayout, fromVisual]) {
      expect(box.top).toBeCloseTo(165.8, 6);
      expect(box.bottom).toBeCloseTo(205.8, 6);
    }
    expect(onScreen({ top: 100, bottom: 200 }, 0, 0)).toEqual({ top: 100, bottom: 200 });
  });

  it('stops a move down before a focused control would leave the top of the screen', () => {
    // A chip whose top is at 100 may rise to the upper line, 84px, not the 132 the box asks for.
    expect(scrollToShow({ top: 722, bottom: 783 }, sight, 100)).toBe(84);
    expect(scrollToShow({ top: 722, bottom: 783 }, sight, 500)).toBe(132);
    // A control already above the line holds the page still, and a move up is never held back.
    expect(scrollToShow({ top: 722, bottom: 783 }, sight, -74)).toBe(0);
    expect(scrollToShow({ top: -51, bottom: 10 }, sight, 300)).toBe(-67);
  });

  it('never moves focus and jumps as the page does, starting as a question begins and settling as it ends', () => {
    const reveal = source.slice(source.indexOf('const REVEAL_DELAY'), source.indexOf('// Clears the Ask panel'));
    expect(reveal).not.toContain('.focus(');
    expect(reveal).not.toContain('behavior');
    // The second move waits two frames, so the answer is laid out before the page scrolls to it.
    expect(reveal).toMatch(/requestAnimationFrame\(\(\) =>\s+requestAnimationFrame\(/);
    const begin = source.slice(source.indexOf('function begin('), source.indexOf('async function answer(')).trimEnd();
    expect(begin.endsWith('  watch(ui);\n}')).toBe(true);
    expect(begin.indexOf('watch(ui);')).toBeGreaterThan(begin.indexOf('setStatus(ui, WORKING_MESSAGE);'));
    const occupy = source.slice(source.indexOf('async function occupy('), source.indexOf('export function ask()'));
    expect(occupy.indexOf('settle(ui);')).toBeGreaterThan(occupy.indexOf('working(ui, -1);'));
    expect(occupy.indexOf('settle(ui);')).toBeLessThan(occupy.indexOf('ui.busy = false;'));
    expect(source).toContain("head: element(askRoot, '[data-ask-head]'),");
    expect(readFileSync('src/components/AskBox.astro', 'utf8')).toMatch(/\.ask-panel,\s*\.ask-panel > \.console-head \{\s*scroll-margin: var\(--space-4\);/);
  });

  // Only a control in the form shown as focused holds the page: a tap, or a click on a chip, leaves
  // the page free to move.
  it('holds the page only for a control in the form reached by keyboard', () => {
    const bring = source.slice(source.indexOf('function bring('), source.indexOf('function watch('));
    expect(bring).toContain('ui.form.contains(focused)');
    expect(bring).toContain("focused.matches(':focus-visible')");
  });
});

describe("the console's Clear", () => {
  const source = readFileSync('src/scripts/console.ts', 'utf8');
  const bootstrap = readFileSync('src/scripts/bootstrap.ts', 'utf8');
  const css = readFileSync('src/styles/console.css', 'utf8');
  const markup = readFileSync('src/components/Console.astro', 'utf8');

  it('has something to clear only with text in the editor, a result under it or a message on the error line', () => {
    const none = { childElementCount: 0 };
    const quiet = { textContent: '' };
    expect(clearable('', none, quiet)).toBe(false);
    expect(clearable('SELECT 1', none, quiet)).toBe(true);
    expect(clearable('', { childElementCount: 1 }, quiet)).toBe(true);
    expect(clearable('', none, { textContent: GUARD })).toBe(true);
  });

  // A fake panel whose every write lands in one log, in the order it happens.
  function fakePanel(status: string, inFlight = 0) {
    const log: string[] = [];
    const text = (name: string, start: string) => {
      let value = start;
      return {
        get textContent() {
          return value;
        },
        set textContent(next: string) {
          value = next;
          log.push(`${name}:${next}`);
        },
      };
    };
    const ui = {
      root: {},
      status: text('status', status),
      error: text('error', 'no such column: x'),
      results: { replaceChildren: (...nodes: unknown[]) => log.push(`replaceChildren:${nodes.length}`), removeAttribute: (name: string) => log.push(`removeAttribute:${name}`) },
      inFlight,
      suffix: '',
      input: {
        set value(next: string) {
          log.push(`value:${next}`);
        },
        focus: (options?: FocusOptions) => log.push(`focus:${options?.preventScroll}`),
      },
      clear: {
        set hidden(state: boolean) {
          log.push(`hidden:${state}`);
        },
      },
    };
    return { ui: ui as unknown as Parameters<typeof clearConsole>[0], log };
  }

  it('empties the editor and what the last run showed, then focuses the editor, then hides', () => {
    const { ui, log } = fakePanel('3 rows');
    clearConsole(ui, true);
    expect(log).toEqual(['value:', 'replaceChildren:0', 'removeAttribute:tabindex', 'error:', 'status:', 'focus:true', 'hidden:true']);
  });

  it('keeps the loading message while the database is still on its way', () => {
    const { ui, log } = fakePanel('loading database, 106 KB');
    clearConsole(ui, false);
    expect(log).not.toContain('status:');
    expect(ui.status.textContent).toBe('loading database, 106 KB');
  });

  it('leaves a panel alone while a query runs, so its result never lands in an emptied panel', () => {
    const { ui, log } = fakePanel('3 rows', 1);
    clearConsole(ui, true);
    expect(log).toEqual([]);
  });

  it('clears only from its own button, before the branches that would run the query', () => {
    expect(source.match(/clearConsole\(/g)).toHaveLength(2);
    expect(source).toMatch(/if \(button\.hasAttribute\('data-console-clear'\)\) \{\s*if \(consoleUi\) clearConsole\(consoleUi\);\s*return;/);
    const click = source.slice(source.indexOf('export function click('));
    expect(click.indexOf("hasAttribute('data-console-clear')")).toBeLessThan(click.indexOf('if (askUi?.box.contains(button))'));
    expect(click.indexOf("hasAttribute('data-console-clear')")).toBeLessThan(click.indexOf('else run();'));
    // The example buttons still load their query and run it.
    expect(click).toMatch(/if \(sql !== undefined\) query\(sql\);\s*else run\(\);/);
    expect(source).toMatch(/function query\(sql: string\): void \{\s*if \(!consoleUi\) return;\s*consoleUi\.input\.value = sql;\s*syncClear\(consoleUi\);\s*run\(\);/);
  });

  it('decides whether Clear shows after every change to the editor, the results or the error line', () => {
    expect(source.match(/syncClear\(/g)!.length).toBe(7);
    expect(source).toContain('void execute(ui, sql).then(() => syncClear(ui));');
    expect(source).toMatch(/export function typed\(\): void \{\s*if \(consoleUi\) syncClear\(consoleUi\);/);
    expect(source).toMatch(/consoleUi\.input\.value = sql \?\? askUi\.sql\.textContent \?\? '';\s*syncClear\(consoleUi\);/);
    expect(bootstrap).toContain("editor?.addEventListener('input', () => void ready().then((module) => module.typed()));");
    expect(bootstrap).toMatch(/closest<HTMLElement>\('[^']*\[data-console-clear\][^']*'\)/);
  });

  it('sits hidden straight after Run as a text button, and hides while a query runs', () => {
    // Named for what it clears, the shown word first, as the theme toggle names itself.
    expect(markup).toMatch(
      /<button type="button" class="console-run" data-console-run>Run<\/button>\s*<!--[\s\S]*?-->\s*<button type="button" class="console-clear" data-console-clear hidden><span class="visually-hidden">Clear query<\/span><span aria-hidden="true">Clear<\/span><\/button>/,
    );
    const rule = css.match(/\n\.console-clear \{([^}]*)\}/)![1]!;
    for (const line of ['border: 0;', 'background: none;', 'text-decoration: underline;', 'min-width: var(--control);', 'min-height: var(--control);', 'margin-left: var(--space-4);']) {
      expect(rule).toContain(line);
    }
    expect(css).toMatch(/\.console\[data-working\] > \.console-clear \{\s*visibility: hidden;\s*\}/);
  });
});
