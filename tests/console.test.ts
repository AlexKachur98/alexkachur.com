import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { examples } from '../src/data/examples.ts';
import { holdsPage, markOverflow, onScreen, scrollToShow } from '../src/scripts/ask-box.ts';
import { clearable, clearConsole, setStatus } from '../src/scripts/console.ts';
import { createExecutor, guard } from '../src/scripts/executor.ts';
import type { WorkerLike, WorkerReply } from '../src/scripts/executor.ts';
import { renderCell, sqlTokens, summary, visibleRows } from '../src/scripts/results.ts';
import type { Cell, Result } from '../src/scripts/results.ts';
import { ROWS } from '../src/lib/result-rows.ts';
import schema from '../src/generated/schema.json';

// The chunk's source, all four of its modules, for the few checks below that no behaviour test
// can make.
const source = ['console', 'ask-box', 'executor', 'results'].map((name) => readFileSync(`src/scripts/${name}.ts`, 'utf8')).join('\n');

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

  it('restarts the worker from the kept buffer after a timeout', async () => {
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
  // The SQL and the explanation come from the model, so nothing here ever turns a string into markup.
  it('never builds markup from a string', () => {
    expect(source).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML/);
  });

  // The bootstrap owns every listener, so an interaction before the chunk loads is never lost.
  it('leaves every listener to the bootstrap', () => {
    expect(source).not.toMatch(/addEventListener/);
  });
});

describe('results box', () => {
  it('shows the scroll words only while a capped box holds more than it shows', () => {
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
});

describe('bringing the answer into sight', () => {
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

  // Bringing the answer into sight scrolls the page only: it never takes focus, and it jumps as the
  // page does rather than animate.
  it('never moves focus and never animates the scroll', () => {
    const reveal = source.slice(source.indexOf('const REVEAL_DELAY'), source.indexOf('// Clears the Ask panel'));
    expect(reveal.length).toBeGreaterThan(0);
    expect(reveal).not.toContain('.focus(');
    expect(reveal).not.toContain('behavior');
  });

  // Only a control in the form shown as focused holds the page, and a text box only where the
  // pointer is a mouse or trackpad: a tap, or a click on a chip, leaves the page free to move.
  it('holds the page only for a control in the form reached by keyboard', () => {
    const form = { contains: (element: unknown) => (element as { inForm: boolean }).inForm };
    const control = (tagName: string, visible: boolean, inForm = true) => ({ tagName, inForm, matches: (selector: string) => selector === ':focus-visible' && visible }) as unknown as Element;
    expect(holdsPage(form, control('BUTTON', true), false)).toBe(true);
    expect(holdsPage(form, control('INPUT', true), true)).toBe(true);
    expect(holdsPage(form, control('INPUT', true), false)).toBe(false);
    expect(holdsPage(form, control('BUTTON', false), true)).toBe(false);
    expect(holdsPage(form, control('BUTTON', true, false), true)).toBe(false);
  });
});

describe("the console's Clear", () => {
  it('has something to clear only with text, a result or an error line', () => {
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
});
