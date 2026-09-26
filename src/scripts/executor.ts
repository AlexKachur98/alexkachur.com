// Running a query in the browser: the worker over the site's database, the 3-second limit, and
// the sentences for a query the console refuses or could not run.
import { errorMessage } from '../lib/error-message.ts';
import { ROWS } from '../lib/result-rows.ts';
import type { Cell, Result } from './results.ts';

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
}

export const WORKER_URL = '/console-worker.js';
const TIMEOUT_MS = 3000;
const GUARD_MESSAGE = 'Read-only console: SELECT, WITH and EXPLAIN only.';
const TIMEOUT_MESSAGE = `query stopped after ${TIMEOUT_MS / 1000} s`;
const LOAD_MESSAGE = 'The database could not be loaded. Reload the page to try again.';

// The prefix check. It only produces the friendly message; read-only itself is the
// engine's PRAGMA in the worker.
export function guard(sql: string): string | null {
  return /^\s*(?:select|with|explain)\b/i.test(sql) ? null : GUARD_MESSAGE;
}

// A failed open (the fetch, the worker script, the wasm, bytes that are not a database) keeps
// its cause for the console but is told apart from a failed query, which shows what SQLite said.
class LoadError extends Error {}

export function failure(error: unknown): string {
  return error instanceof LoadError ? LOAD_MESSAGE : errorMessage(error);
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
export function createExecutor({ spawn, load }: ExecutorOptions): Executor {
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
    }, TIMEOUT_MS);
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
        throw new LoadError(errorMessage(error), { cause: error });
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

// The URL from the markup carries the version of the file's bytes, so a returning visitor gets the
// database this page was built with, not an older one their browser kept.
export async function fetchDatabase(url: string | undefined): Promise<ArrayBuffer> {
  if (!url) throw new Error('console: data-db-url is missing');
  // A download that stalls fails like any other rather than leave the console loading for good.
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.arrayBuffer();
}
