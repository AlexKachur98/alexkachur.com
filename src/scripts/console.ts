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
// The empty-result sentence is split: its first words go on the status line and the rest under
// the results, so the status line always fits on one line.
const EMPTY_STATUS = 'No rows';
const EMPTY_NOTE = 'The query ran; the data just does not have that.';
const LOAD_MESSAGE = 'The database could not be loaded. Reload the page to try again.';
const WORKING_MESSAGE = 'working';
const CACHED_LABEL = 'cached';
const UNUSABLE_MESSAGE = 'I could not turn that into a safe query. Try rephrasing, or write the SQL yourself.';
// The three sentences that point at the raw console, and the same sentences cut for a page that
// has no console (404), where the examples run in the Ask panel instead. Two of them name how
// many examples follow, as a word taken from the list the panel shows.
const RATE_LIMITED_MESSAGE = {
  console: 'Too many questions from your connection. Try again in a minute, or type SQL directly below.',
  alone: 'Too many questions from your connection. Try again in a minute.',
};
const BUDGET_MESSAGE = {
  console: (count: string) => `The AI budget for this month is used up. The raw console still works, and here are ${count} questions with their SQL.`,
  alone: (count: string) => `The AI budget for this month is used up. Here are ${count} questions with their SQL.`,
};
const UPSTREAM_MESSAGE = {
  console: (count: string) => `The AI service is not responding right now. The raw console still works, and here are ${count} questions with their SQL.`,
  alone: (count: string) => `The AI service is not responding right now. Here are ${count} questions with their SQL.`,
};
// A send that did not go through: the day's quota is used up, or anything else, which asking again
// mends, since a new answer brings a new token.
const DAILY_CAP_MESSAGE = 'The site has taken all the questions it can for today. Try again tomorrow.';
const SEND_FAILED_MESSAGE = 'The question could not be sent. Ask it again to try once more.';
const NUMBER_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];

export function countWord(n: number): string {
  return NUMBER_WORDS[n] ?? String(n);
}
const TIMEOUT_MS = 3000;
const WORKER_URL = '/console-worker.js';
const ASK_URL = '/api/ask';
const SEND_URL = '/api/questions';

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
// which the server never sends back. Some listed words (ASC, DESC, LEFT and others) are also
// valid names in SQLite; they stay because a query almost always uses them as syntax, so an alias
// spelled like one takes the colour. END is the exception: the experience table has an end
// column, so END counts only when it closes a CASE.
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
  // CASE expressions still waiting for their END, and whether the last token finished a value.
  // END closes a CASE only right after a value; where a value is expected, as after ELSE or a
  // comma, the word is the end column.
  let open = 0;
  let afterValue = false;
  for (const match of sql.matchAll(SQL_TOKEN)) {
    const text = match[0];
    const word = text.toUpperCase();
    let keyword = ASCII_WORD.test(text) && sql[match.index - 1] !== '.' && SQL_KEYWORDS.has(word);
    if (keyword && word === 'CASE') open += 1;
    if (keyword && word === 'END') {
      if (open > 0 && afterValue) open -= 1;
      else keyword = false;
    }
    if (!/^\s$/.test(text) && !text.startsWith('--') && !text.startsWith('/*')) {
      afterValue = keyword ? word === 'NULL' || word === 'END' : text === ')' || text.charCodeAt(0) > 127 || /^(?:[\w'"`[]|\.\d)/.test(text);
    }
    if (keyword) {
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
  if (result.rows.length === 0) return EMPTY_STATUS;
  if (result.truncated) return TRUNCATED_MESSAGE;
  return result.rows.length === 1 ? '1 row' : `${result.rows.length} rows`;
}

// What /api/ask answered, or null when no reply arrived at all (the network, not the service).
export interface Reply {
  status: number;
  body: unknown;
}

// What the Ask panel shows for a reply. An answer runs its SQL; a refusal shows only the model's
// sentence; a failure shows one of the copy sentences, with the example queries listed when the
// AI is out of reach and the console is the way forward.
// An answer or a refusal carries the token that lets the visitor send the question, when the reply
// had one.
export type AskState =
  | { kind: 'answer'; sql: string; explanation: string; cached: boolean; token?: string }
  | { kind: 'refusal'; explanation: string; cached: boolean; token?: string }
  | { kind: 'failed'; message: string; fallback: boolean };

function field(body: unknown, name: string): unknown {
  return body !== null && typeof body === 'object' ? (body as Record<string, unknown>)[name] : undefined;
}

// withConsole says whether the page also has the raw console the sentences point at; listed is
// how many examples the fallback list holds.
export function askState(reply: Reply | null, withConsole: boolean, listed: number): AskState {
  const wording = withConsole ? 'console' : 'alone';
  const count = countWord(listed);
  const upstream: AskState = { kind: 'failed', message: UPSTREAM_MESSAGE[wording](count), fallback: true };
  if (!reply) return upstream;
  const { status, body } = reply;
  if (status === 200) {
    const sql = field(body, 'sql');
    const explanation = field(body, 'explanation');
    if (typeof sql !== 'string' || typeof explanation !== 'string') return upstream;
    const cached = field(body, 'cached') === true;
    const token = field(body, 'token');
    const extra = typeof token === 'string' && token !== '' ? { token } : {};
    if (sql.trim() === '') return { kind: 'refusal', explanation, cached, ...extra };
    return { kind: 'answer', sql, explanation, cached, ...extra };
  }
  // A 400 (a question under three characters) shares the unusable sentence.
  if (status === 400 || status === 422) return { kind: 'failed', message: UNUSABLE_MESSAGE, fallback: false };
  if (status === 429) return { kind: 'failed', message: RATE_LIMITED_MESSAGE[wording], fallback: false };
  // A missing variable in production reads the same as a used-up month to the visitor.
  const reason = field(body, 'reason');
  if (status === 503 && (reason === 'budget' || reason === 'config')) {
    return { kind: 'failed', message: BUDGET_MESSAGE[wording](count), fallback: true };
  }
  return upstream;
}

export type SendOutcome = 'sent' | 'rate_limited' | 'daily_cap' | 'refused' | 'failed';

// Sending a question to Alex, apart from the page so it can be tested: offer() holds the
// question and its token and posts nothing; only send(), which the send button's click calls,
// posts. reset() withdraws the offer, and a reply that arrives after it is dropped, so a slow
// send can never write into the next answer. One send at a time for each offer: a send still
// pending for an earlier question does not block the next one.
export function createSender(post: (body: { question: string; token: string }) => Promise<Reply | null>) {
  let offered: { question: string; token: string; generation: number } | null = null;
  let generation = 0;
  // The offer whose send is in flight, if any.
  let inFlight: number | null = null;
  return {
    offer(question: string, token: string): void {
      generation += 1;
      offered = { question, token, generation };
    },
    reset(): void {
      generation += 1;
      offered = null;
    },
    async send(): Promise<SendOutcome | null> {
      if (!offered || inFlight === offered.generation) return null;
      const mine = offered;
      inFlight = mine.generation;
      try {
        const reply = await post({ question: mine.question, token: mine.token });
        if (mine.generation !== generation) return null;
        if (reply?.status === 200) {
          offered = null;
          return 'sent';
        }
        if (reply?.status === 429) return field(reply.body, 'error') === 'daily_cap' ? 'daily_cap' : 'rate_limited';
        // A refused token or question stays refused, so the offer ends; any other failure can be
        // tried again.
        if (reply?.status === 403 || reply?.status === 400) {
          offered = null;
          return 'refused';
        }
        return 'failed';
      } finally {
        if (inFlight === mine.generation) inFlight = null;
      }
    },
  };
}

// The sentence the error line shows for a send that did not go through.
export function sendMessage(outcome: Exclude<SendOutcome, 'sent'>): string {
  if (outcome === 'rate_limited') return RATE_LIMITED_MESSAGE.alone;
  if (outcome === 'daily_cap') return DAILY_CAP_MESSAGE;
  return SEND_FAILED_MESSAGE;
}

// The parts the two panels share: the working attribute for the cursor, the status and error
// regions, and the results container. The suffix follows the status a run ends on; the Ask
// panel sets it to the cached label so the row count reads "2 rows, cached", while working and
// loading stay short.
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
  form: HTMLElement;
  input: HTMLInputElement;
  // The control that clears the question field, shown while the field holds text.
  clear: HTMLElement;
  question: HTMLElement;
  explanation: HTMLElement;
  sql: HTMLElement;
  edit: HTMLElement | null;
  fallback: HTMLElement;
  // The lines an example can show under its table, hidden until that example runs.
  more: HTMLElement[];
  // The offer to send a question the site could not answer, and the thanks that replaces it.
  sendBlock: HTMLElement;
  sent: HTMLElement;
  // The example answer a wide screen shows before the first question, if the page has one.
  example: HTMLElement | null;
  busy: boolean;
  // The words after the row count saying the results box scrolls, shown while it does.
  scrollCue: HTMLElement;
  // The answer's head line: the question, and the status line under it.
  head: HTMLElement;
  // Set while a question is in flight whose answer the page will scroll into sight.
  reveal: Reveal | undefined;
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
export function setStatus(panel: Panel, text: string, final = false): void {
  const suffix = final ? panel.suffix : '';
  const full = text && suffix ? `${text}, ${suffix}` : text || suffix;
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
  if (result.rows.length === 0) {
    const note = document.createElement('p');
    note.className = 'console-empty';
    note.textContent = EMPTY_NOTE;
    panel.results.replaceChildren(table, note);
  } else {
    panel.results.replaceChildren(table);
  }
  // Each result starts at its first row and column, wherever the last one was scrolled to.
  panel.results.scrollTo(0, 0);
  panel.results.tabIndex = 0;
}

// The rest of an empty result's sentence belongs to the "No rows" it follows. A run removes it
// when it starts, and again if it fails, since an earlier run ahead of it in the queue may have
// painted one while it waited.
function dropNote(panel: Panel): void {
  panel.results.querySelector('.console-empty')?.remove();
}

// The result when the query ran, undefined when it was refused or failed.
async function execute(panel: Panel, sql: string): Promise<Result | undefined> {
  if (!executor) return undefined;
  dropNote(panel);
  const problem = guard(sql);
  if (problem) {
    setStatus(panel, panel.inFlight > 0 ? WORKING_MESSAGE : '');
    setError(panel, problem);
    return undefined;
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
    setStatus(panel, summary(result), true);
    return result;
  } catch (error) {
    dropNote(panel);
    setStatus(panel, '', true);
    setError(panel, failure(error));
    return undefined;
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

// Where the answer opens under the form (below 1200px, at every width on the 404 page, and in a
// browser without subgrid), a phone often has it below the bottom of the screen, so a question would
// change nothing in sight. When the answer's head starts out of sight, the page moves for the
// visitor. If the answer is not in after a tenth of a second, about as long as a response can take
// and still feel immediate, it moves just far enough to show the question and its working line.
// Once the answer is in, it moves far enough to show all of it, or its top when it is taller than
// the screen, unless the visitor has scrolled since. That second move waits two frames, so the
// answer is laid out below the screen before the page scrolls to it: made in the same frame, Chrome
// counts it as a layout shift of everything under the answer. Focus stays where it was, and screen
// readers hear the status line as before; a control reached by keyboard also keeps its place on
// screen, so its focus ring stays in sight. The page jumps rather than glides, as a link to a
// section does.
const REVEAL_DELAY = 100;

interface Reveal {
  timer: ReturnType<typeof setTimeout>;
  // Where the page was when it last moved on its own; anywhere else means the visitor scrolled.
  at: number;
}

// How far to scroll so a box sits between two lines: all of it when it fits, its top when it does
// not, nothing when it is already there. Given the top of a control that must stay in sight, a move
// down stops before that top passes the upper line.
export function scrollToShow(box: { top: number; bottom: number }, sight: { top: number; bottom: number }, keep?: number): number {
  let by = 0;
  if (box.top < sight.top || box.bottom - box.top > sight.bottom - sight.top) by = box.top - sight.top;
  else if (box.bottom > sight.bottom) by = box.bottom - sight.bottom;
  return keep === undefined || by <= 0 ? by : Math.min(by, Math.max(0, keep - sight.top));
}

// Where a box sits in the visual viewport, the part of the page actually on screen, given the root
// element's top as measured with the box and how far down the page the visual viewport starts.
// While an on-screen keyboard is up or the page is zoomed, the visual viewport is shorter than the
// layout viewport and can sit anywhere inside it, and browsers disagree about which of the two a
// box is measured from. Against the root element the box's place on the page comes out the same
// either way, and the visual viewport's place on the page is its pageTop.
export function onScreen(box: { top: number; bottom: number }, root: number, page: number): { top: number; bottom: number } {
  return { top: box.top - root - page, bottom: box.bottom - root - page };
}

// The visual viewport never starts above the line scrollY gives, so the larger of the two is its top.
// On an iPhone with the keyboard up, pageTop can still give the top from before a scroll the page
// has just made itself, while scrollY and every box already have the new one.
function place(element: Element): { top: number; bottom: number } {
  const root = document.documentElement.getBoundingClientRect().top;
  const top = Math.max(window.visualViewport?.pageTop ?? 0, window.scrollY);
  return onScreen(element.getBoundingClientRect(), root, top);
}

// The visual viewport less the element's scroll margin, measured the same way.
function sight(element: HTMLElement): { top: number; bottom: number } {
  const style = getComputedStyle(element);
  const height = window.visualViewport?.height ?? window.innerHeight;
  return { top: parseFloat(style.scrollMarginTop), bottom: height - parseFloat(style.scrollMarginBottom) };
}

function distance(element: HTMLElement): number {
  return scrollToShow(place(element), sight(element));
}

// A control in the form reached by keyboard keeps its place on screen. A text box matches
// :focus-visible however it was focused, so it holds the page only where the main pointer is a
// mouse or trackpad; on a phone the page moves past it to show the answer.
function bring(ui: AskUi, element: HTMLElement): void {
  const focused = document.activeElement;
  const kept =
    focused instanceof HTMLElement &&
    ui.form.contains(focused) &&
    focused.matches(':focus-visible') &&
    (focused instanceof HTMLButtonElement || matchMedia('(pointer: fine)').matches);
  window.scrollBy(0, scrollToShow(place(element), sight(element), kept ? place(focused).top : undefined));
}

function watch(ui: AskUi): void {
  if (distance(ui.head) === 0) return;
  const reveal: Reveal = {
    at: window.scrollY,
    timer: setTimeout(() => {
      if (window.scrollY !== reveal.at) return;
      bring(ui, ui.head);
      reveal.at = window.scrollY;
    }, REVEAL_DELAY),
  };
  ui.reveal = reveal;
}

function settle(ui: AskUi): void {
  const reveal = ui.reveal;
  ui.reveal = undefined;
  if (!reveal) return;
  clearTimeout(reveal.timer);
  if (window.scrollY !== reveal.at) return;
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      if (!ui.busy) bring(ui, ui.root);
    }),
  );
}

// Clears the Ask panel for a new question and opens it, the question on its header line. The
// panel is always in the markup so its two live regions exist before they are written to; it
// takes up space only once it has something to show. The example answer goes for good, so the
// visitor's answer takes its place rather than appearing under it. Its height stays behind as the
// pane's smallest height, which the stylesheet uses only beside the form, so an answer shorter than
// the example moves nothing on the page and a longer one moves it only by the difference. The
// height goes on the panel's style object, which the content security policy allows, unlike a
// style attribute in the markup.
function begin(ui: AskUi, question: string): void {
  if (ui.example) {
    ui.root.style.setProperty('--example-height', `${ui.example.getBoundingClientRect().height}px`);
    ui.example.remove();
    ui.example = null;
  }
  ui.root.setAttribute('data-open', '');
  ui.question.textContent = question;
  ui.suffix = '';
  ui.explanation.textContent = '';
  ui.sql.textContent = '';
  setError(ui, '');
  ui.results.replaceChildren();
  ui.results.removeAttribute('tabindex');
  ui.scrollCue.hidden = true;
  if (ui.edit) ui.edit.hidden = true;
  ui.fallback.hidden = true;
  for (const line of ui.more) line.hidden = true;
  sender.reset();
  ui.sendBlock.hidden = true;
  ui.sent.hidden = true;
  setStatus(ui, WORKING_MESSAGE);
  watch(ui);
}

async function answer(ui: AskUi, sql: string): Promise<Result | undefined> {
  ui.sql.replaceChildren(...sqlNodes(sql));
  if (ui.edit) ui.edit.hidden = false;
  const result = await execute(ui, sql);
  markOverflow(ui.results, ui.scrollCue, capped(ui.results));
  return result;
}

// A capped results box that holds more than it shows, below its foot or past its right edge, says
// so after the row count, since a scrollbar is not always drawn and the row or column the box cuts
// can look whole. Only where the box is capped: there the status line has room for the words, and
// in a phone's narrower pane they would push a longer status onto a second line. The words stay for
// as long as the box overflows, not only until its end is reached, so the status line never
// changes while the box is being scrolled. A pixel of difference is rounding, not a hidden row.
export function markOverflow(
  results: Pick<HTMLElement, 'scrollHeight' | 'clientHeight' | 'scrollWidth' | 'clientWidth'>,
  cue: Pick<HTMLElement, 'hidden'>,
  capped: boolean,
): void {
  cue.hidden = !capped || (results.scrollHeight - results.clientHeight <= 1 && results.scrollWidth - results.clientWidth <= 1);
}

// Whether the stylesheet caps this results box, which it does only beside the form.
const capped = (box: HTMLElement): boolean => getComputedStyle(box).maxHeight !== 'none';

// A typed question the site could not answer, a refusal or a query with no rows, can be sent to
// Alex; the offer only shows the button, and nothing leaves the page until it is clicked.
async function show(ui: AskUi, state: AskState, question: string): Promise<void> {
  if (state.kind === 'failed') {
    setStatus(ui, '');
    setError(ui, state.message);
    ui.fallback.hidden = !state.fallback;
    return;
  }
  ui.explanation.textContent = state.explanation;
  ui.suffix = state.cached ? CACHED_LABEL : '';
  let unanswered = true;
  if (state.kind === 'refusal') setStatus(ui, '', true);
  else unanswered = (await answer(ui, state.sql))?.rows.length === 0;
  if (unanswered && state.token) {
    sender.offer(question, state.token);
    ui.sendBlock.hidden = false;
  }
}

async function postSend(body: { question: string; token: string }): Promise<Reply | null> {
  try {
    // A send that hangs gives up rather than holding its button for the rest of the visit.
    const response = await fetch(SEND_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    return { status: response.status, body: await response.json().catch(() => undefined) };
  } catch {
    return null;
  }
}

const sender = createSender(postSend);

// The send button's click, the one way a question is sent. On success the thanks takes the
// button's place and the focus; a refusal hides the button and hands focus back to the input.
async function sendAsked(): Promise<void> {
  const outcome = await sender.send();
  if (!outcome || !askUi) return;
  const ui = askUi;
  if (outcome === 'sent') {
    setError(ui, '');
    ui.sendBlock.hidden = true;
    ui.sent.hidden = false;
    ui.sent.focus({ preventScroll: true });
    return;
  }
  setError(ui, sendMessage(outcome));
  if (outcome === 'refused') {
    ui.sendBlock.hidden = true;
    ui.input.focus({ preventScroll: true });
  }
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
    settle(ui);
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
    await show(ui, askState(await post(question), consoleUi !== undefined, ui.fallback.querySelectorAll('li').length), question);
  });
}

// A chip, or one of the fallback examples: reviewed SQL run locally, no request made. An example
// with a line of its own shows it under the table once the query has run. The fallback list
// hides as the run starts, taking the activated button with it, so focus is put back afterwards:
// on the results when a table was painted, else on the input.
function askQuery(ui: AskUi, sql: string, label: string, fromList: boolean, more: string | undefined): void {
  void occupy(ui, label, async () => {
    const result = await answer(ui, sql);
    const line = more === undefined ? undefined : ui.more.find((candidate) => candidate.dataset['askMore'] === more);
    if (result && line) line.hidden = false;
  }).then((started) => {
    if (!started || !fromList) return;
    const target = ui.results.hasAttribute('tabindex') ? ui.results : ui.input;
    target.focus({ preventScroll: true });
  });
}

// The question field's clear control, apart from the page so its rules can be tested without one.
// Clearing touches only the field and the control, so the answer stays until the next question.
export interface QuestionField {
  value: string;
  focus(options?: FocusOptions): void;
}

// The parts of a keydown that decide whether Escape clears.
export interface ClearKey {
  key: string;
  isComposing: boolean;
  keyCode: number;
}

export function showClear(field: Pick<QuestionField, 'value'>, control: Pick<HTMLElement, 'hidden'>): void {
  control.hidden = field.value === '';
}

// Focus goes back to the field before the control hides, so it is never left on a hidden control.
export function clearQuestion(field: QuestionField, control: Pick<HTMLElement, 'hidden'>): void {
  field.value = '';
  field.focus({ preventScroll: true });
  control.hidden = true;
}

// Escape clears only a field with text in it, and never during an input method's composition.
export function escapeClears(event: ClearKey, value: string): boolean {
  return event.key === 'Escape' && !event.isComposing && event.keyCode !== 229 && value !== '';
}

// Typing in the question field, which the bootstrap forwards.
export function askTyped(): void {
  if (askUi) showClear(askUi.input, askUi.clear);
}

// A keydown of Escape in the question field, which the bootstrap forwards.
export function askEscape(event: ClearKey): void {
  if (askUi && escapeClears(event, askUi.input.value)) clearQuestion(askUi.input, askUi.clear);
}

// Moves the SQL into the raw console for editing and brings the console into view: the answer's,
// or the example's, which its button carries.
function edit(sql: string | undefined): void {
  if (!askUi || !consoleUi) return;
  consoleUi.input.value = sql ?? askUi.sql.textContent ?? '';
  consoleUi.root.scrollIntoView();
  consoleUi.input.focus({ preventScroll: true });
}

// The bootstrap owns every listener and forwards a click on an example, a chip, Run, Edit this
// query, the question field's clear control or the send button here, whether it landed before
// this module was loaded or after.
// Edit this query is checked before the chips: a click on the example's button can arrive after a
// question has already taken the example off the page, and it still means edit, not run.
export function click(button: HTMLElement): void {
  const sql = button.dataset['sql'];
  if (button.hasAttribute('data-ask-send')) {
    void sendAsked();
    return;
  }
  if (button.hasAttribute('data-ask-edit')) {
    edit(sql);
    return;
  }
  if (button.hasAttribute('data-ask-clear')) {
    if (askUi) clearQuestion(askUi.input, askUi.clear);
    return;
  }
  if (askUi?.box.contains(button)) {
    if (sql !== undefined) {
      askQuery(askUi, sql, button.textContent?.trim() ?? '', askUi.fallback.contains(button), button.dataset['more']);
    }
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
      form: element(askRoot, '[data-ask-form]'),
      input: element(askRoot, '[data-ask-input]'),
      clear: element(askRoot, '[data-ask-clear]'),
      question: element(askRoot, '[data-ask-question]'),
      explanation: element(askRoot, '[data-ask-explanation]'),
      sql: element(askRoot, '[data-ask-sql]'),
      // The answer's own button, not the example's, which sits deeper in the panel.
      edit: askRoot.querySelector<HTMLElement>('[data-ask-panel] > [data-ask-edit]'),
      fallback: element(askRoot, '[data-ask-fallback]'),
      more: [...askRoot.querySelectorAll<HTMLElement>('[data-ask-more]')],
      sendBlock: element(askRoot, '[data-ask-send-block]'),
      sent: element(askRoot, '[data-ask-sent]'),
      example: askRoot.querySelector<HTMLElement>('[data-ask-example]'),
      busy: false,
      scrollCue: element(askRoot, '[data-ask-scroll-cue]'),
      head: element(askRoot, '[data-ask-head]'),
      reveal: undefined,
    };
    // Text typed, or restored by the browser, before this module ran shows the control too.
    showClear(askUi.input, askUi.clear);
    // A resize can cap or uncap the box, which changes whether it overflows without a new answer.
    const ui = askUi;
    new ResizeObserver(() => markOverflow(ui.results, ui.scrollCue, capped(ui.results))).observe(ui.results);
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
