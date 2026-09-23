// The console chunk: loaded by the bootstrap's ready() on the first interaction
// and never before. Nothing runs at module level, so evaluating it early on pointerdown is
// free. One executor owns the worker, the 3-second timer and the row cap, and one renderer
// paints results into either panel: the raw console and the Ask box, which posts the question
// to /api/ask and runs the SQL it gets back through the same path.
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
const CACHED_LABEL = 'cached';
const UNUSABLE_MESSAGE = 'I could not turn that into a safe query. Try rephrasing, or write the SQL yourself.';
// The three sentences that point at the raw console, and the same sentences cut for a page that
// has no console (404), where the six examples run in the Ask panel instead.
const RATE_LIMITED_MESSAGE = {
  console: 'Too many questions from your connection. Try again in a minute, or type SQL directly below.',
  alone: 'Too many questions from your connection. Try again in a minute.',
};
const BUDGET_MESSAGE = {
  console: 'The AI budget for this month is used up. The raw console still works, and here are six questions with their SQL.',
  alone: 'The AI budget for this month is used up. Here are six questions with their SQL.',
};
const UPSTREAM_MESSAGE = {
  console: 'The AI service is not responding right now. The raw console still works, and here are six questions with their SQL.',
  alone: 'The AI service is not responding right now. Here are six questions with their SQL.',
};
const TIMEOUT_MS = 3000;
const WORKER_URL = '/console-worker.js';
const ASK_URL = '/api/ask';

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

export function failure(error: unknown): string {
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

// What a cell renders as. Beyond plain text: a photo_url column whose value is a site image
// becomes a 48px thumbnail linking to the image, with the alt text from the pets collection and
// never from the shape of the query; a value that is a web address or an email address, in any
// column, becomes a link so a visitor can follow it straight from the results.
export type Rendered =
  | { kind: 'text'; text: string; empty: boolean }
  | { kind: 'image'; src: string; alt: string }
  | { kind: 'link'; href: string; text: string };

const alts: Record<string, string> = photoAlt;
const WEB_ADDRESS = /^https?:\/\/\S+$/;
const EMAIL_ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function renderCell(column: string, value: Cell, alt: Record<string, string> = alts): Rendered {
  if (column === 'photo_url' && typeof value === 'string' && value.startsWith('/images/')) {
    const file = value.slice(value.lastIndexOf('/') + 1);
    return { kind: 'image', src: value, alt: alt[value] ?? file.replace(/\.[^.]+$/, '') };
  }
  if (typeof value === 'string') {
    const text = value.trim();
    if (WEB_ADDRESS.test(text)) return { kind: 'link', href: text, text };
    if (EMAIL_ADDRESS.test(text)) return { kind: 'link', href: `mailto:${text}`, text };
  }
  if (value === null) return { kind: 'text', text: 'NULL', empty: true };
  return { kind: 'text', text: String(value), empty: false };
}

export function visibleRows(result: Result): Cell[][] {
  return result.rows.slice(0, ROWS);
}

// The SQL an answer shows, split so its keywords can take their colour. Only syntax words count:
// strings, quoted names, comments and numbers stay plain, and so does a word after a dot (a
// column) or one with letters outside ASCII, which SQLite reads as a name. Left out on purpose:
// KEY and DATE, which are columns here; COUNT and every other function, since a query often
// names a column after one (COUNT(*) AS count); type names; words more often a name than syntax
// (FIRST, LAST, FILTER, PLAN and the like); and EXPLAIN and every statement other than a query,
// which the server never sends back. Some listed words (ASC, DESC, END, LEFT and others) are
// also valid names in SQLite; they stay because a query almost always uses them as syntax, so an
// alias spelled like one takes the colour.
const SQL_KEYWORDS = new Set([
  'SELECT', 'DISTINCT', 'ALL', 'FROM', 'WHERE', 'GROUP', 'BY', 'HAVING', 'ORDER', 'ASC', 'DESC', 'LIMIT', 'OFFSET', 'AS', 'WITH', 'RECURSIVE',
  'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER', 'CROSS', 'NATURAL', 'ON', 'USING',
  'UNION', 'INTERSECT', 'EXCEPT', 'VALUES',
  'AND', 'OR', 'NOT', 'IN', 'IS', 'NULL', 'LIKE', 'GLOB', 'ESCAPE', 'BETWEEN', 'EXISTS', 'ISNULL', 'NOTNULL', 'COLLATE',
  'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'CAST',
  'OVER', 'PARTITION', 'WINDOW',
]);

// One token at a time from the start: a string with its doubled quotes, a quoted or bracketed
// name, a comment, a number, a word (SQLite allows any character from U+0080 up in a name), or
// any single character. An unterminated quote or comment runs to the end.
const SQL_TOKEN =
  /'(?:[^']|'')*'?|"(?:[^"]|"")*"?|`(?:[^`]|``)*`?|\[[^\]]*\]?|--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?|[A-Za-z_\u0080-\uFFFF][\w$\u0080-\uFFFF]*|[\s\S]/gy;
const ASCII_WORD = /^[A-Za-z]+$/;

export interface SqlToken {
  text: string;
  keyword: boolean;
}

// Plain runs are merged, so the tokens alternate and joining their text gives the SQL back.
export function sqlTokens(sql: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  let plain = '';
  for (const match of sql.matchAll(SQL_TOKEN)) {
    const text = match[0];
    if (ASCII_WORD.test(text) && sql[match.index - 1] !== '.' && SQL_KEYWORDS.has(text.toUpperCase())) {
      if (plain !== '') tokens.push({ text: plain, keyword: false });
      tokens.push({ text, keyword: true });
      plain = '';
    } else {
      plain += text;
    }
  }
  if (plain !== '') tokens.push({ text: plain, keyword: false });
  return tokens;
}

// The SQL comes from the model, so it is built as text nodes and spans, never parsed as HTML.
function sqlNodes(sql: string): Node[] {
  return sqlTokens(sql).map(({ text, keyword }) => {
    if (!keyword) return document.createTextNode(text);
    const span = document.createElement('span');
    span.className = 'sql-keyword';
    span.textContent = text;
    return span;
  });
}

// The status line after a run: the row count, or the two copy strings for none and for more.
export function summary(result: Result): string {
  if (result.rows.length === 0) return EMPTY_MESSAGE;
  if (result.truncated) return TRUNCATED_MESSAGE;
  return result.rows.length === 1 ? '1 row' : `${result.rows.length} rows`;
}

// What /api/ask answered, or null when no reply arrived at all (the network, not the service).
export interface Reply {
  status: number;
  body: unknown;
}

// What the Ask panel shows for a reply. An answer runs its SQL; a refusal shows only the model's
// sentence; a failure shows one of the copy sentences, with the six example queries listed when
// the AI is out of reach and the console is the way forward.
export type AskState =
  | { kind: 'answer'; sql: string; explanation: string; cached: boolean }
  | { kind: 'refusal'; explanation: string; cached: boolean }
  | { kind: 'failed'; message: string; fallback: boolean };

function field(body: unknown, name: string): unknown {
  return body !== null && typeof body === 'object' ? (body as Record<string, unknown>)[name] : undefined;
}

// withConsole says whether the page also has the raw console the sentences point at.
export function askState(reply: Reply | null, withConsole = true): AskState {
  const wording = withConsole ? 'console' : 'alone';
  const upstream: AskState = { kind: 'failed', message: UPSTREAM_MESSAGE[wording], fallback: true };
  if (!reply) return upstream;
  const { status, body } = reply;
  if (status === 200) {
    const sql = field(body, 'sql');
    const explanation = field(body, 'explanation');
    if (typeof sql !== 'string' || typeof explanation !== 'string') return upstream;
    const cached = field(body, 'cached') === true;
    if (sql.trim() === '') return { kind: 'refusal', explanation, cached };
    return { kind: 'answer', sql, explanation, cached };
  }
  // A 400 (a question under three characters) shares the unusable sentence.
  if (status === 400 || status === 422) return { kind: 'failed', message: UNUSABLE_MESSAGE, fallback: false };
  if (status === 429) return { kind: 'failed', message: RATE_LIMITED_MESSAGE[wording], fallback: false };
  // A missing variable in production reads the same as a used-up month to the visitor.
  const reason = field(body, 'reason');
  if (status === 503 && (reason === 'budget' || reason === 'config')) {
    return { kind: 'failed', message: BUDGET_MESSAGE[wording], fallback: true };
  }
  return upstream;
}

// The parts the two panels share: the working attribute for the cursor, the status and error
// regions, and the results container. The suffix follows every status text; the Ask panel
// sets it to the cached label so the row count reads "2 rows, cached".
interface Panel {
  root: HTMLElement;
  status: HTMLElement;
  error: HTMLElement;
  results: HTMLElement;
  inFlight: number;
  suffix: string;
}

interface ConsoleUi extends Panel {
  input: HTMLTextAreaElement;
}

interface AskUi extends Panel {
  // The whole box: the form with its chips as well as the panel.
  box: HTMLElement;
  input: HTMLInputElement;
  question: HTMLElement;
  explanation: HTMLElement;
  sql: HTMLElement;
  edit: HTMLElement | null;
  fallback: HTMLElement;
  busy: boolean;
}

let executor: Executor | undefined;
let loaded = false;
let kb = '';
let consoleUi: ConsoleUi | undefined;
let askUi: AskUi | undefined;

function element<T extends HTMLElement>(root: ParentNode, selector: string): T {
  const found = root.querySelector<T>(selector);
  if (!found) throw new Error(`console: ${selector} is missing`);
  return found;
}

// Unchanged text is left alone: replacing a text node with the same words still fires a live
// region change, and the loading message can be written by the preload and by a click.
function setStatus(panel: Panel, text: string): void {
  const full = text && panel.suffix ? `${text}, ${panel.suffix}` : text || panel.suffix;
  if (panel.status.textContent !== full) panel.status.textContent = full;
}

function setError(panel: Panel, text: string): void {
  panel.error.textContent = text;
}

function loadingMessage(): string {
  return `loading database, ${kb} KB`;
}

function working(panel: Panel, delta: number): void {
  panel.inFlight += delta;
  if (panel.inFlight > 0) panel.root.setAttribute('data-working', '');
  else panel.root.removeAttribute('data-working');
}

function paint(panel: Panel, result: Result): void {
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
      } else if (cell.kind === 'link') {
        const link = document.createElement('a');
        link.href = cell.href;
        link.textContent = cell.text;
        td.append(link);
      } else {
        td.textContent = cell.text;
        if (cell.empty) td.classList.add('null');
      }
    });
  }
  // One DOM operation, so assistive technology sees a single change; the CSS row reveal does
  // the rest. The container scrolls sideways for wide results, so it must take focus.
  panel.results.replaceChildren(table);
  panel.results.tabIndex = 0;
}

async function execute(panel: Panel, sql: string): Promise<void> {
  if (!executor) return;
  const problem = guard(sql);
  if (problem) {
    setStatus(panel, panel.inFlight > 0 ? WORKING_MESSAGE : '');
    setError(panel, problem);
    return;
  }
  setError(panel, '');
  setStatus(panel, loaded ? WORKING_MESSAGE : loadingMessage());
  working(panel, 1);
  try {
    const result = await executor.run(sql);
    // A run can be the open that succeeds after the preload's open failed.
    loaded = true;
    // An earlier query in the queue may have failed since this one was submitted.
    setError(panel, '');
    paint(panel, result);
    setStatus(panel, summary(result));
  } catch (error) {
    setStatus(panel, '');
    setError(panel, failure(error));
  } finally {
    working(panel, -1);
  }
}

// Runs whatever the textarea holds. Blank input is ignored, like an empty line at a prompt.
export function run(): void {
  if (!consoleUi) return;
  const sql = consoleUi.input.value.trim();
  if (sql !== '') void execute(consoleUi, sql);
}

function query(sql: string): void {
  if (!consoleUi) return;
  consoleUi.input.value = sql;
  run();
}

// Clears the Ask panel for a new question and opens it, the question on its header line. The
// panel is always in the markup so its two live regions exist before they are written to; it
// takes up space only once it has something to show.
function begin(ui: AskUi, question: string): void {
  ui.root.setAttribute('data-open', '');
  ui.question.textContent = question;
  ui.suffix = '';
  ui.explanation.textContent = '';
  ui.sql.textContent = '';
  setError(ui, '');
  ui.results.replaceChildren();
  ui.results.removeAttribute('tabindex');
  if (ui.edit) ui.edit.hidden = true;
  ui.fallback.hidden = true;
  setStatus(ui, WORKING_MESSAGE);
}

async function answer(ui: AskUi, sql: string): Promise<void> {
  ui.sql.replaceChildren(...sqlNodes(sql));
  if (ui.edit) ui.edit.hidden = false;
  await execute(ui, sql);
}

async function show(ui: AskUi, state: AskState): Promise<void> {
  if (state.kind === 'failed') {
    setStatus(ui, '');
    setError(ui, state.message);
    ui.fallback.hidden = !state.fallback;
    return;
  }
  ui.explanation.textContent = state.explanation;
  ui.suffix = state.cached ? CACHED_LABEL : '';
  if (state.kind === 'refusal') setStatus(ui, '');
  else await answer(ui, state.sql);
}

async function post(question: string): Promise<Reply | null> {
  try {
    const response = await fetch(ASK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question }),
    });
    return { status: response.status, body: await response.json().catch(() => undefined) };
  } catch {
    return null;
  }
}

// One question at a time: a submit or a chip while one is in flight does nothing. The cursor
// blinks from the request to the last row painted.
async function occupy(ui: AskUi, question: string, work: () => Promise<void>): Promise<boolean> {
  if (ui.busy) return false;
  ui.busy = true;
  begin(ui, question);
  working(ui, 1);
  try {
    await work();
  } finally {
    working(ui, -1);
    // A question that ended without a run and without a failure would keep the word.
    if (ui.status.textContent?.startsWith(WORKING_MESSAGE)) setStatus(ui, '');
    ui.busy = false;
  }
  return true;
}

// Submits the input: the question goes to /api/ask while the worker and the database, started
// by the focus that preceded typing, finish loading. Blank input is ignored.
export function ask(): void {
  if (!askUi || !executor) return;
  const ui = askUi;
  const question = ui.input.value.trim();
  if (question === '') return;
  void occupy(ui, question, async () => {
    // A load that failed earlier is retried alongside the request; the run reports it if it
    // fails again, and nothing is reported when there is no SQL to run.
    executor?.ready().catch(() => undefined);
    await show(ui, askState(await post(question), consoleUi !== undefined));
  });
}

// A chip, or one of the six fallback examples: reviewed SQL run locally, no request made. The
// fallback list hides as the run starts, taking the activated button with it, so focus is put
// back afterwards: on the results when there are rows, else on the input.
function askQuery(ui: AskUi, sql: string, label: string, fromList: boolean): void {
  void occupy(ui, label, () => answer(ui, sql)).then((started) => {
    if (!started || !fromList) return;
    const target = ui.results.hasAttribute('tabindex') ? ui.results : ui.input;
    target.focus({ preventScroll: true });
  });
}

// Moves the SQL into the raw console for editing and brings the console into view.
function edit(): void {
  if (!askUi || !consoleUi) return;
  consoleUi.input.value = askUi.sql.textContent ?? '';
  consoleUi.root.scrollIntoView();
  consoleUi.input.focus({ preventScroll: true });
}

// The bootstrap owns every listener and forwards a click on an example, a chip, Run or Edit
// this query here, whether it landed before this module was loaded or after.
export function click(button: HTMLElement): void {
  const sql = button.dataset['sql'];
  if (askUi?.box.contains(button)) {
    if (button.hasAttribute('data-ask-edit')) edit();
    else if (sql !== undefined) askQuery(askUi, sql, button.textContent?.trim() ?? '', askUi.fallback.contains(button));
    return;
  }
  if (sql !== undefined) query(sql);
  else run();
}

function panelOf(root: HTMLElement, prefix: string): Panel {
  return {
    root,
    status: element(root, `[data-${prefix}-status]`),
    error: element(root, `[data-${prefix}-error]`),
    results: element(root, `[data-${prefix}-results]`),
    inFlight: 0,
    suffix: '',
  };
}

// Called once by the bootstrap's ready(): starts the worker and the database fetch, showing the
// byte size in the console while they load. A page has the console, the Ask box or both; the
// database URL and size are on whichever is there.
export function init(): void {
  if (executor) return;
  const source = element<HTMLElement>(document.body, '[data-db-url]');
  kb = source.dataset['kb'] ?? '';
  executor = createExecutor({
    spawn: () => new Worker(WORKER_URL),
    load: () => fetchDatabase(source.dataset['dbUrl']),
  });
  const consoleRoot = document.querySelector<HTMLElement>('[data-console]');
  if (consoleRoot) {
    consoleUi = { ...panelOf(consoleRoot, 'console'), input: element(consoleRoot, '[data-console-input]') };
    setStatus(consoleUi, loadingMessage());
  }
  const askRoot = document.querySelector<HTMLElement>('[data-ask]');
  if (askRoot) {
    askUi = {
      ...panelOf(element(askRoot, '[data-ask-panel]'), 'ask'),
      box: askRoot,
      input: element(askRoot, '[data-ask-input]'),
      question: element(askRoot, '[data-ask-question]'),
      explanation: element(askRoot, '[data-ask-explanation]'),
      sql: element(askRoot, '[data-ask-sql]'),
      edit: askRoot.querySelector<HTMLElement>('[data-ask-edit]'),
      fallback: element(askRoot, '[data-ask-fallback]'),
      busy: false,
    };
  }
  executor.ready().then(
    () => {
      loaded = true;
      if (consoleUi) setStatus(consoleUi, consoleUi.inFlight > 0 ? WORKING_MESSAGE : '');
    },
    (error: unknown) => {
      if (!consoleUi) return;
      setStatus(consoleUi, '');
      setError(consoleUi, failure(error));
    },
  );
}
