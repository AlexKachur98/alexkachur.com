import { describe, expect, it } from 'vitest';
import { examples } from '../src/data/examples.ts';
import { askState, clearQuestion, countWord, createExecutor, createSender, escapeClears, failure, sendMessage, showClear } from '../src/scripts/console.ts';
import type { AskState, WorkerLike } from '../src/scripts/console.ts';

// The sentences written out here rather than imported, so a typo in the module cannot pass by
// comparing the module to itself.
const RATE_LIMITED = 'Too many questions from your connection. Try again in a minute, or type SQL directly below.';
const BUDGET = 'The AI budget for this month is used up. The raw console still works, and here are eight questions with their SQL.';
const UPSTREAM = 'The AI service is not responding right now. The raw console still works, and here are eight questions with their SQL.';
const UNUSABLE = 'I could not turn that into a safe query. Try rephrasing, or write the SQL yourself.';
const LOAD_FAILED = 'The database could not be loaded. Reload the page to try again.';

const failed = (message: string, fallback: boolean): AskState => ({ kind: 'failed', message, fallback });

// The panel passes how many examples its fallback list holds; here that is the real list.
const state = (reply: Parameters<typeof askState>[0], withConsole = true) => askState(reply, withConsole, examples.length);

describe('askState', () => {
  it('runs the SQL of a 200 with a non-empty sql, keeping the explanation and the cached flag', () => {
    expect(state({ status: 200, body: { sql: 'SELECT name FROM pets', explanation: 'Lists the pets.', cached: false } })).toEqual({
      kind: 'answer',
      sql: 'SELECT name FROM pets',
      explanation: 'Lists the pets.',
      cached: false,
    });
    expect(state({ status: 200, body: { sql: 'SELECT 1', explanation: '', cached: true } })).toEqual({
      kind: 'answer',
      sql: 'SELECT 1',
      explanation: '',
      cached: true,
    });
  });

  it('shows only the explanation for a refusal, the empty sql of a 200', () => {
    expect(state({ status: 200, body: { sql: '', explanation: 'The schema has no salary data.', cached: false } })).toEqual({
      kind: 'refusal',
      explanation: 'The schema has no salary data.',
      cached: false,
    });
    expect(state({ status: 200, body: { sql: '  ', explanation: 'Nothing to run.', cached: true } })).toEqual({
      kind: 'refusal',
      explanation: 'Nothing to run.',
      cached: true,
    });
  });

  it('treats a 200 whose body is not the promised shape as the service not responding', () => {
    expect(state({ status: 200, body: undefined })).toEqual(failed(UPSTREAM, true));
    expect(state({ status: 200, body: { sql: 1, explanation: 'x' } })).toEqual(failed(UPSTREAM, true));
    expect(state({ status: 200, body: 'ok' })).toEqual(failed(UPSTREAM, true));
  });

  it('shows the unusable sentence for a 400 and a 422, with no example list', () => {
    expect(state({ status: 400, body: { error: 'invalid_question' } })).toEqual(failed(UNUSABLE, false));
    expect(state({ status: 422, body: { error: 'unusable_output' } })).toEqual(failed(UNUSABLE, false));
  });

  it('shows the rate limit sentence for a 429, with no example list', () => {
    expect(state({ status: 429, body: { error: 'rate_limited' } })).toEqual(failed(RATE_LIMITED, false));
  });

  it('shows the budget sentence and the examples for a 503 budget', () => {
    expect(state({ status: 503, body: { reason: 'budget' } })).toEqual(failed(BUDGET, true));
  });

  // A missing key or a retired model is no used-up month, so it never says the budget is spent.
  it('shows the upstream sentence and the examples for a 503 upstream or config', () => {
    expect(state({ status: 503, body: { reason: 'upstream' } })).toEqual(failed(UPSTREAM, true));
    expect(state({ status: 503, body: { reason: 'config' } })).toEqual(failed(UPSTREAM, true));
  });

  it('shows the upstream sentence for no reply, an unknown reason and any other status', () => {
    expect(state(null)).toEqual(failed(UPSTREAM, true));
    expect(state({ status: 503, body: { reason: 'surprise' } })).toEqual(failed(UPSTREAM, true));
    expect(state({ status: 503, body: undefined })).toEqual(failed(UPSTREAM, true));
    expect(state({ status: 500, body: { error: 'internal' } })).toEqual(failed(UPSTREAM, true));
    expect(state({ status: 502, body: undefined })).toEqual(failed(UPSTREAM, true));
    expect(state({ status: 404, body: undefined })).toEqual(failed(UPSTREAM, true));
  });

  it('shows only copy for any status but 200, whatever the body says', () => {
    const leak = 'Authentication error: invalid x-api-key';
    for (const status of [400, 422, 429, 500, 503]) {
      const shown = state({ status, body: { error: leak, reason: leak, explanation: leak, sql: leak } });
      expect(shown.kind, String(status)).toBe('failed');
      expect(JSON.stringify(shown)).not.toContain(leak);
    }
  });

  it('names the number of listed examples as a word', () => {
    expect(examples).toHaveLength(8);
    expect(countWord(examples.length)).toBe('eight');
    expect(askState(null, true, 6)).toEqual(failed(UPSTREAM.replace('eight', 'six'), true));
  });

  it('cuts the console clause from the sentences on a page without the raw console', () => {
    expect(state({ status: 429, body: {} }, false)).toEqual(failed('Too many questions from your connection. Try again in a minute.', false));
    expect(state({ status: 503, body: { reason: 'budget' } }, false)).toEqual(failed('The AI budget for this month is used up. Here are eight questions with their SQL.', true));
    expect(state({ status: 503, body: { reason: 'config' } }, false)).toEqual(failed('The AI service is not responding right now. Here are eight questions with their SQL.', true));
    expect(state({ status: 503, body: { reason: 'upstream' } }, false)).toEqual(failed('The AI service is not responding right now. Here are eight questions with their SQL.', true));
    expect(state(null, false)).toEqual(failed('The AI service is not responding right now. Here are eight questions with their SQL.', true));
    // The unusable sentence names no console and stays whole.
    expect(state({ status: 422, body: {} }, false)).toEqual(failed(UNUSABLE, false));
    expect(state({ status: 200, body: { sql: 'SELECT 1', explanation: 'One.', cached: false } }, false)).toMatchObject({ kind: 'answer' });
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

describe('sending a question to Alex', () => {
  const reply = (status: number, body: unknown = {}) => ({ status, body });

  function recorder(answer: { status: number; body: unknown } | null = reply(200, { sent: true })) {
    const posts: { question: string; token: string }[] = [];
    const post = async (body: { question: string; token: string }) => {
      posts.push(body);
      return answer;
    };
    return { posts, sender: createSender(post) };
  }

  it('posts nothing when it offers, only when send is called', async () => {
    const { posts, sender } = recorder();
    sender.offer('Who is Alex?', 'tok');
    expect(posts).toEqual([]);
    expect(await sender.send()).toBe('sent');
    expect(posts).toEqual([{ question: 'Who is Alex?', token: 'tok' }]);
    // Sent once; a second click has nothing left to send.
    expect(await sender.send()).toBeNull();
    expect(posts).toHaveLength(1);
  });

  it('sends nothing after reset or with no offer, and drops a reply that arrives after a new question', async () => {
    const { posts, sender } = recorder();
    expect(await sender.send()).toBeNull();
    sender.offer('Who is Alex?', 'tok');
    sender.reset();
    expect(await sender.send()).toBeNull();
    expect(posts).toEqual([]);
    sender.offer('Who is Alex?', 'tok');
    const pending = sender.send();
    sender.reset();
    expect(await pending).toBeNull();
  });

  it('names each failure, and a refused token or question is not offered again', async () => {
    const cases: [ReturnType<typeof reply> | null, string][] = [
      [reply(429, { error: 'rate_limited' }), 'rate_limited'],
      [reply(429, { error: 'daily_cap' }), 'daily_cap'],
      [reply(503, { reason: 'upstream' }), 'failed'],
      [null, 'failed'],
      [reply(403, { error: 'invalid_token' }), 'refused'],
      [reply(400, { error: 'invalid_question' }), 'refused'],
    ];
    for (const [answer, outcome] of cases) {
      const { sender } = recorder(answer);
      sender.offer('Who is Alex?', 'tok');
      expect(await sender.send()).toBe(outcome);
    }
    const { posts, sender } = recorder(reply(403, { error: 'invalid_token' }));
    sender.offer('Who is Alex?', 'tok');
    await sender.send();
    expect(await sender.send()).toBeNull();
    expect(posts).toHaveLength(1);
  });

  it('lets a new question be sent while an older send is still pending', async () => {
    let release: (value: { status: number; body: unknown }) => void = () => {};
    const posts: string[] = [];
    const sender = createSender(async (body) => {
      posts.push(body.question);
      if (posts.length === 1) return new Promise((resolve) => (release = resolve));
      return reply(200, { sent: true });
    });
    sender.offer('First question?', 'a');
    const first = sender.send();
    // A second click on the same offer while it is in flight sends nothing.
    expect(await sender.send()).toBeNull();
    sender.reset();
    sender.offer('Second question?', 'b');
    expect(await sender.send()).toBe('sent');
    release(reply(200, { sent: true }));
    expect(await first).toBeNull();
    expect(posts).toEqual(['First question?', 'Second question?']);
  });

  it('shows the sentence for each send that did not go through', () => {
    expect(sendMessage('rate_limited')).toBe('Too many questions from your connection. Try again in a minute.');
    expect(sendMessage('daily_cap')).toBe('The site has taken all the questions it can for today. Try again tomorrow.');
    expect(sendMessage('failed')).toBe('The question could not be sent. Ask it again to try once more.');
    expect(sendMessage('refused')).toBe('The question could not be sent. Ask it again to try once more.');
  });

  it('carries the token of an answer or a refusal into the panel state', () => {
    expect(askState(reply(200, { sql: '', explanation: 'No.', cached: false, token: 't' }), true, 8)).toMatchObject({ kind: 'refusal', token: 't' });
    expect(askState(reply(200, { sql: 'SELECT 1', explanation: 'One.', cached: false, token: 't' }), true, 8)).toMatchObject({ kind: 'answer', token: 't' });
    expect(askState(reply(200, { sql: 'SELECT 1', explanation: 'One.', cached: false }), true, 8)).not.toHaveProperty('token');
  });
});

describe("the question field's clear control", () => {
  it('shows only while the field holds text', () => {
    const control = { hidden: false };
    showClear({ value: '' }, control);
    expect(control.hidden).toBe(true);
    showClear({ value: 'a' }, control);
    expect(control.hidden).toBe(false);
    showClear({ value: ' ' }, control);
    expect(control.hidden).toBe(false);
  });

  it('empties the field, keeps focus in it, then hides', () => {
    const log: string[] = [];
    const field = {
      get value() {
        return 'x';
      },
      set value(text: string) {
        log.push(`value:${text}`);
      },
      focus(options?: FocusOptions) {
        log.push(`focus:${options?.preventScroll}`);
      },
    };
    const control = {
      set hidden(state: boolean) {
        log.push(`hidden:${state}`);
      },
      get hidden() {
        return false;
      },
    };
    clearQuestion(field, control);
    expect(log).toEqual(['value:', 'focus:true', 'hidden:true']);
  });

  it('clears on Escape only with text in the field, never during composition, and on no other key', () => {
    const escape = { key: 'Escape', isComposing: false, keyCode: 27 };
    expect(escapeClears(escape, 'x')).toBe(true);
    expect(escapeClears(escape, '')).toBe(false);
    expect(escapeClears({ ...escape, isComposing: true }, 'x')).toBe(false);
    expect(escapeClears({ ...escape, keyCode: 229 }, 'x')).toBe(false);
    for (const key of ['Enter', 'Backspace', 'Delete', 'x', 'Tab']) expect(escapeClears({ key, isComposing: false, keyCode: 0 }, 'x'), key).toBe(false);
  });
});
