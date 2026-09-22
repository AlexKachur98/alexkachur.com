// The console chunk: loaded by the bootstrap's ready() on the first interaction
// and never before. Nothing runs at module level, so evaluating it early on pointerdown is
// free. The executor owns the worker, the 3-second timer and the row cap; the Ask box will run
// its validated SQL through the same executor and renderer.
import { photoAlt } from '../generated/schema.json';

export type Cell = string | number | null | Uint8Array;

export interface Result {
  columns: string[];
  rows: Cell[][];
  truncated: boolean;
}

// Messages from public/console-worker.js.
export type WorkerReply =
  | { type: 'ready' }
  | { type: 'started' }
  | { type: 'result'; columns: string[]; rows: Cell[][]; truncated: boolean }
  | { type: 'error'; error: string };

export interface WorkerLike {
  postMessage(message: unknown): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<WorkerReply>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
}

export interface Executor {
  ready(): Promise<void>;
  run(sql: string): Promise<Result>;
}

export interface ExecutorOptions {
  spawn: () => WorkerLike;
  load: () => Promise<ArrayBuffer>;
  timeout?: number;
}

export const ROWS = 50;
export const THUMB = 48;
const GUARD_MESSAGE = 'Read-only console: SELECT, WITH and EXPLAIN only.';
const TIMEOUT_MESSAGE = 'query stopped after 3 s';
const TRUNCATED_MESSAGE = 'showing 50 of more';
const EMPTY_MESSAGE = 'No rows. The query ran; the data just does not have that.';
const LOAD_MESSAGE = 'The database could not be loaded. Reload the page to try again.';
const WORKING_MESSAGE = 'working';
const TIMEOUT_MS = 3000;
const WORKER_URL = '/console-worker.js';

// The prefix check. It only produces the friendly message; read-only itself is the
// engine's PRAGMA in the worker.
export function guard(sql: string): string | null {
  return /^\s*(?:select|with|explain)\b/i.test(sql) ? null : GUARD_MESSAGE;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// A failed open (the fetch, the worker script, the wasm, bytes that are not a database) keeps
// its cause for the console but is told apart from a failed query, which shows what SQLite said.
class LoadError extends Error {}

function failure(error: unknown): string {
  return error instanceof LoadError ? LOAD_MESSAGE : message(error);
}

interface Pending {
  resolve: (result: Result) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

interface Session {
  worker: WorkerLike;
  alive: boolean;
  pending: Pending | undefined;
}

// One worker at a time. The database buffer is fetched once and kept, so a worker killed by the
// timer is replaced from memory; queries run one after another, each waiting for the open.
export function createExecutor({ spawn, load, timeout = TIMEOUT_MS }: ExecutorOptions): Executor {
  let buffer: ArrayBuffer | undefined;
  let opening: Promise<Session> | undefined;
  let queue: Promise<unknown> = Promise.resolve();

  function take(session: Session): Pending | undefined {
    const pending = session.pending;
    session.pending = undefined;
    if (pending) clearTimeout(pending.timer);
    return pending;
  }

  function resolvePending(session: Session, result: Result): void {
    take(session)?.resolve(result);
  }

  function rejectPending(session: Session, error: Error): void {
    take(session)?.reject(error);
  }

  function kill(session: Session): void {
    session.alive = false;
    session.worker.terminate();
  }

  // Armed on "started", so it never covers the wasm load or the open. A statement stuck inside
  // wasm cannot be interrupted, only abandoned: the worker is terminated and a new one reopens
  // the database from the buffer kept here.
  function arm(session: Session): void {
    if (!session.pending) return;
    session.pending.timer = setTimeout(() => {
      kill(session);
      rejectPending(session, new Error(TIMEOUT_MESSAGE));
      const attempt = start();
      opening = attempt;
      // Nobody awaits this open; if it fails, forget it so the next query starts afresh.
      attempt.catch(() => {
        if (opening === attempt) opening = undefined;
      });
    }, timeout);
  }

  function start(): Promise<Session> {
    // The worker starts first so sql.js loads while the database downloads.
    const worker = spawn();
    const session: Session = { worker, alive: true, pending: undefined };
    let posted = false;
    const ready = new Promise<void>((resolve, reject) => {
      worker.onmessage = ({ data }) => {
        if (!session.alive) return;
        if (data.type === 'ready') resolve();
        else if (data.type === 'started') arm(session);
        else if (data.type === 'result') {
          resolvePending(session, { columns: data.columns, rows: data.rows, truncated: data.truncated });
        } else if (data.type === 'error') {
          const error = new Error(data.error);
          reject(error);
          rejectPending(session, error);
        }
      };
      // A worker that fails to load fires an error event that may carry no message at all.
      worker.onerror = (event) => {
        const error = new Error(event.message || WORKER_URL);
        reject(error);
        rejectPending(session, error);
      };
    });
    // The worker can fail while the download is still running; the rejection is picked up below.
    ready.catch(() => undefined);
    return (async () => {
      try {
        buffer ??= await load();
        // Structured clone, no transfer list: this thread keeps its copy for the next open.
        worker.postMessage({ type: 'open', buffer });
        posted = true;
        await ready;
        return session;
      } catch (error) {
        // Bytes the worker refused are not kept for a retry.
        if (posted) buffer = undefined;
        kill(session);
        throw new LoadError(message(error), { cause: error });
      }
    })();
  }

  // A failed open (the fetch, the worker script, the wasm) is forgotten, so the next call tries
  // again from scratch; one that a later timeout replaced is left alone.
  async function connect(): Promise<Session> {
    const attempt = (opening ??= start());
    try {
      return await attempt;
    } catch (error) {
      if (opening === attempt) opening = undefined;
      throw error;
    }
  }

  function run(sql: string): Promise<Result> {
    const result = queue.then(async () => {
      const session = await connect();
      return new Promise<Result>((resolve, reject) => {
        session.pending = { resolve, reject, timer: undefined };
        session.worker.postMessage({ type: 'exec', sql, limit: ROWS + 1 });
      });
    });
    queue = result.catch(() => undefined);
    return result;
  }

  return { ready: () => connect().then(() => undefined), run };
}

// The URL comes from the markup, where the build put the version of the file's bytes in the
// query string: the file is cached as immutable with no hash in its name, and a returning visitor
// must get the database this page was built with, not the one their browser kept.
async function fetchDatabase(url: string | undefined): Promise<ArrayBuffer> {
  if (!url) throw new Error('console: data-db-url is missing');
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.arrayBuffer();
}

// What a cell renders as. The one rule beyond plain text: a photo_url column whose
// value is a site image becomes a 48px thumbnail linking to the image, with the alt text from
// the pets collection and never from the shape of the query.
export type Rendered = { kind: 'text'; text: string; empty: boolean } | { kind: 'image'; src: string; alt: string };

const alts: Record<string, string> = photoAlt;

export function renderCell(column: string, value: Cell, alt: Record<string, string> = alts): Rendered {
  if (column === 'photo_url' && typeof value === 'string' && value.startsWith('/images/')) {
    const file = value.slice(value.lastIndexOf('/') + 1);
    return { kind: 'image', src: value, alt: alt[value] ?? file.replace(/\.[^.]+$/, '') };
  }
  if (value === null) return { kind: 'text', text: 'NULL', empty: true };
  return { kind: 'text', text: String(value), empty: false };
}

export function visibleRows(result: Result): Cell[][] {
  return result.rows.slice(0, ROWS);
}

// The status line after a run: the row count, or the two copy strings for none and for more.
export function summary(result: Result): string {
  if (result.rows.length === 0) return EMPTY_MESSAGE;
  if (result.truncated) return TRUNCATED_MESSAGE;
  return result.rows.length === 1 ? '1 row' : `${result.rows.length} rows`;
}

interface Ui {
  root: HTMLElement;
  input: HTMLTextAreaElement;
  status: HTMLElement;
  error: HTMLElement;
  results: HTMLElement;
  executor: Executor;
  loaded: boolean;
  inFlight: number;
}

let ui: Ui | undefined;

function element<T extends HTMLElement>(root: HTMLElement, selector: string): T {
  const found = root.querySelector<T>(selector);
  if (!found) throw new Error(`console: ${selector} is missing`);
  return found;
}

// Unchanged text is left alone: replacing a text node with the same words still fires a live
// region change, and the loading message can be written by the preload and by a click.
function setStatus(text: string): void {
  if (ui && ui.status.textContent !== text) ui.status.textContent = text;
}

function setError(text: string): void {
  if (ui) ui.error.textContent = text;
}

function loadingMessage(): string {
  return `loading database, ${ui?.root.dataset.kb} KB`;
}

function working(delta: number): void {
  if (!ui) return;
  ui.inFlight += delta;
  if (ui.inFlight > 0) ui.root.setAttribute('data-working', '');
  else ui.root.removeAttribute('data-working');
}

function paint(result: Result): void {
  if (!ui) return;
  const table = document.createElement('table');
  const head = table.createTHead().insertRow();
  for (const column of result.columns) {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = column;
    head.append(th);
  }
  const body = table.createTBody();
  for (const row of visibleRows(result)) {
    const tr = body.insertRow();
    row.forEach((value, index) => {
      const td = tr.insertCell();
      const cell = renderCell(result.columns[index] ?? '', value);
      if (cell.kind === 'image') {
        const link = document.createElement('a');
        link.href = cell.src;
        const img = document.createElement('img');
        img.src = cell.src;
        img.alt = cell.alt;
        img.width = THUMB;
        img.height = THUMB;
        img.loading = 'lazy';
        link.append(img);
        td.append(link);
      } else {
        td.textContent = cell.text;
        if (cell.empty) td.classList.add('null');
      }
    });
  }
  // One DOM operation, so assistive technology sees a single change; the CSS row reveal does
  // the rest. The container scrolls sideways for wide results, so it must take focus.
  ui.results.replaceChildren(table);
  ui.results.tabIndex = 0;
}

async function execute(sql: string): Promise<void> {
  if (!ui) return;
  const problem = guard(sql);
  if (problem) {
    setStatus(ui.inFlight > 0 ? WORKING_MESSAGE : '');
    setError(problem);
    return;
  }
  setError('');
  setStatus(ui.loaded ? WORKING_MESSAGE : loadingMessage());
  working(1);
  try {
    const result = await ui.executor.run(sql);
    // A run can be the open that succeeds after the preload's open failed.
    ui.loaded = true;
    // An earlier query in the queue may have failed since this one was submitted.
    setError('');
    paint(result);
    setStatus(summary(result));
  } catch (error) {
    setStatus('');
    setError(failure(error));
  } finally {
    working(-1);
  }
}

// Runs whatever the textarea holds. Blank input is ignored, like an empty line at a prompt.
export function run(): void {
  if (!ui) return;
  const sql = ui.input.value.trim();
  if (sql !== '') void execute(sql);
}

function query(sql: string): void {
  if (!ui) return;
  ui.input.value = sql;
  run();
}

// The bootstrap owns every listener and forwards a click on an example or on Run here, whether
// it landed before this module was loaded or after.
export function click(button: HTMLElement): void {
  const sql = button.dataset['sql'];
  if (sql !== undefined) query(sql);
  else run();
}

// Called once by the bootstrap's ready(): starts the worker and the database fetch, showing the
// byte size while they load.
export function init(): void {
  if (ui) return;
  const root = element<HTMLElement>(document.body, '[data-console]');
  ui = {
    root,
    input: element<HTMLTextAreaElement>(root, '[data-console-input]'),
    status: element<HTMLElement>(root, '[data-console-status]'),
    error: element<HTMLElement>(root, '[data-console-error]'),
    results: element<HTMLElement>(root, '[data-console-results]'),
    executor: createExecutor({
      spawn: () => new Worker(WORKER_URL),
      load: () => fetchDatabase(root.dataset['dbUrl']),
    }),
    loaded: false,
    inFlight: 0,
  };
  setStatus(loadingMessage());
  ui.executor.ready().then(
    () => {
      if (!ui) return;
      ui.loaded = true;
      setStatus(ui.inFlight > 0 ? WORKING_MESSAGE : '');
    },
    (error: unknown) => {
      setStatus('');
      setError(failure(error));
    },
  );
}
