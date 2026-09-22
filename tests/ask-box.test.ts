import { describe, expect, it } from 'vitest';
import { askState, createExecutor, failure } from '../src/scripts/console.ts';
import type { AskState, WorkerLike } from '../src/scripts/console.ts';

// The sentences written out here rather than imported, so a typo in the module cannot pass by
// comparing the module to itself.
const RATE_LIMITED = 'Too many questions from your connection. Try again in a minute, or type SQL directly below.';
const BUDGET = 'The AI budget for this month is used up. The raw console still works, and here are six questions with their SQL.';
const UPSTREAM = 'The AI service is not responding right now. The raw console still works, and here are six questions with their SQL.';
const UNUSABLE = 'I could not turn that into a safe query. Try rephrasing, or write the SQL yourself.';
const LOAD_FAILED = 'The database could not be loaded. Reload the page to try again.';

const failed = (message: string, fallback: boolean): AskState => ({ kind: 'failed', message, fallback });

describe('askState', () => {
  it('runs the SQL of a 200 with a non-empty sql, keeping the explanation and the cached flag', () => {
    expect(askState({ status: 200, body: { sql: 'SELECT name FROM pets', explanation: 'Lists the pets.', cached: false } })).toEqual({
      kind: 'answer',
      sql: 'SELECT name FROM pets',
      explanation: 'Lists the pets.',
      cached: false,
    });
    expect(askState({ status: 200, body: { sql: 'SELECT 1', explanation: '', cached: true } })).toEqual({
      kind: 'answer',
      sql: 'SELECT 1',
      explanation: '',
      cached: true,
    });
  });

  it('shows only the explanation for a refusal, the empty sql of a 200', () => {
    expect(askState({ status: 200, body: { sql: '', explanation: 'The schema has no salary data.', cached: false } })).toEqual({
      kind: 'refusal',
      explanation: 'The schema has no salary data.',
      cached: false,
    });
    expect(askState({ status: 200, body: { sql: '  ', explanation: 'Nothing to run.', cached: true } })).toEqual({
      kind: 'refusal',
      explanation: 'Nothing to run.',
      cached: true,
    });
  });

  it('treats a 200 whose body is not the promised shape as the service not responding', () => {
    expect(askState({ status: 200, body: undefined })).toEqual(failed(UPSTREAM, true));
    expect(askState({ status: 200, body: { sql: 1, explanation: 'x' } })).toEqual(failed(UPSTREAM, true));
    expect(askState({ status: 200, body: 'ok' })).toEqual(failed(UPSTREAM, true));
  });

  it('shows the unusable sentence for a 400 and a 422, with no example list', () => {
    expect(askState({ status: 400, body: { error: 'invalid_question' } })).toEqual(failed(UNUSABLE, false));
    expect(askState({ status: 422, body: { error: 'unusable_output' } })).toEqual(failed(UNUSABLE, false));
  });

  it('shows the rate limit sentence for a 429, with no example list', () => {
    expect(askState({ status: 429, body: { error: 'rate_limited' } })).toEqual(failed(RATE_LIMITED, false));
  });

  it('shows the budget sentence and the examples for a 503 budget, and the same for config', () => {
    expect(askState({ status: 503, body: { reason: 'budget' } })).toEqual(failed(BUDGET, true));
    expect(askState({ status: 503, body: { reason: 'config' } })).toEqual(failed(BUDGET, true));
  });

  it('shows the upstream sentence and the examples for a 503 upstream', () => {
    expect(askState({ status: 503, body: { reason: 'upstream' } })).toEqual(failed(UPSTREAM, true));
  });

  it('shows the upstream sentence for no reply, an unknown reason and any other status', () => {
    expect(askState(null)).toEqual(failed(UPSTREAM, true));
    expect(askState({ status: 503, body: { reason: 'surprise' } })).toEqual(failed(UPSTREAM, true));
    expect(askState({ status: 503, body: undefined })).toEqual(failed(UPSTREAM, true));
    expect(askState({ status: 500, body: { error: 'internal' } })).toEqual(failed(UPSTREAM, true));
    expect(askState({ status: 502, body: undefined })).toEqual(failed(UPSTREAM, true));
    expect(askState({ status: 404, body: undefined })).toEqual(failed(UPSTREAM, true));
  });

  it('shows only copy for any status but 200, whatever the body says', () => {
    const leak = 'Authentication error: invalid x-api-key';
    for (const status of [400, 422, 429, 500, 503]) {
      const state = askState({ status, body: { error: leak, reason: leak, explanation: leak, sql: leak } });
      expect(state.kind, String(status)).toBe('failed');
      expect(JSON.stringify(state)).not.toContain(leak);
    }
  });

  it('cuts the console clause from the sentences on a page without the raw console', () => {
    expect(askState({ status: 429, body: {} }, false)).toEqual(failed('Too many questions from your connection. Try again in a minute.', false));
    expect(askState({ status: 503, body: { reason: 'budget' } }, false)).toEqual(failed('The AI budget for this month is used up. Here are six questions with their SQL.', true));
    expect(askState({ status: 503, body: { reason: 'config' } }, false)).toEqual(failed('The AI budget for this month is used up. Here are six questions with their SQL.', true));
    expect(askState({ status: 503, body: { reason: 'upstream' } }, false)).toEqual(failed('The AI service is not responding right now. Here are six questions with their SQL.', true));
    expect(askState(null, false)).toEqual(failed('The AI service is not responding right now. Here are six questions with their SQL.', true));
    // The unusable sentence names no console and stays whole.
    expect(askState({ status: 422, body: {} }, false)).toEqual(failed(UNUSABLE, false));
    expect(askState({ status: 200, body: { sql: 'SELECT 1', explanation: 'One.', cached: false } }, false)).toMatchObject({ kind: 'answer' });
  });
});

class DeadWorker implements WorkerLike {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  postMessage(): void {}
  terminate(): void {}
}

describe('failure', () => {
  it('shows the load sentence when the database or the worker could not be loaded', async () => {
    const executor = createExecutor({
      spawn: () => new DeadWorker(),
      load: async () => {
        throw new Error('404 /data/portfolio.sqlite?v=00000000');
      },
    });
    const error = await executor.run('SELECT 1').catch((caught: unknown) => caught);
    expect(failure(error)).toBe(LOAD_FAILED);

    const worker = new DeadWorker();
    const broken = createExecutor({ spawn: () => worker, load: async () => new ArrayBuffer(8) });
    const pending = broken.ready().catch((caught: unknown) => caught);
    for (let i = 0; i < 20; i++) await Promise.resolve();
    worker.onerror?.({ message: '' } as ErrorEvent);
    expect(failure(await pending)).toBe(LOAD_FAILED);
  });

  it("shows SQLite's own text for a query that failed", () => {
    expect(failure(new Error('no such column: nope'))).toBe('no such column: nope');
    expect(failure('Nothing to prepare')).toBe('Nothing to prepare');
  });
});
