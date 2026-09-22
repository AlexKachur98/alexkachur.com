import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { modelName, readoutText } from '../src/scripts/readouts.ts';

const body = (questionsThisMonth: unknown, modelCallsThisMonth: unknown, cap: unknown) => ({ questionsThisMonth, modelCallsThisMonth, cap });

describe('readoutText', () => {
  it('formats the questions and the budget share from a stats body', () => {
    expect(readoutText(body(143, 180, 2000))).toBe('143 questions this month · AI budget 9% used');
    expect(readoutText({ ...body(12, 500, 2000), model: 'x', commit: 'y', builtAt: 'z' })).toBe('12 questions this month · AI budget 25% used');
  });

  it('prints a real zero from the endpoint, which is a count and not a fallback', () => {
    expect(readoutText(body(0, 0, 2000))).toBe('0 questions this month · AI budget 0% used');
  });

  it('uses the singular for one question', () => {
    expect(readoutText(body(1, 1, 2000))).toBe('1 question this month · AI budget 0% used');
  });

  it('rounds the percent to a whole number', () => {
    expect(readoutText(body(3, 15, 1000))).toBe('3 questions this month · AI budget 2% used');
    expect(readoutText(body(3, 25, 1000))).toBe('3 questions this month · AI budget 3% used');
    expect(readoutText(body(3, 1, 2000))).toBe('3 questions this month · AI budget 0% used');
  });

  it('clamps the share at 100 and reads cap 0 as fully used', () => {
    expect(readoutText(body(60, 75, 50))).toBe('60 questions this month · AI budget 100% used');
    expect(readoutText(body(60, 50, 50))).toBe('60 questions this month · AI budget 100% used');
    expect(readoutText(body(9, 0, 0))).toBe('9 questions this month · AI budget 100% used');
  });

  it('gives nothing for anything but the promised shape, so no fallback zero is ever printed', () => {
    for (const value of [null, undefined, 'ok', 42, [], {}, body('143', 1, 2000), body(143, null, 2000), body(143, 1, undefined)]) {
      expect(readoutText(value), JSON.stringify(value)).toBeNull();
    }
    for (const value of [body(-1, 1, 2000), body(1.5, 1, 2000), body(1, Number.NaN, 2000), body(1, 1, Number.POSITIVE_INFINITY)]) {
      expect(readoutText(value), JSON.stringify(value)).toBeNull();
    }
  });
});

describe('modelName', () => {
  it('reads the model id from a stats body', () => {
    expect(modelName({ ...body(1, 1, 2000), model: 'claude-haiku-4-5' })).toBe('claude-haiku-4-5');
    expect(modelName({ model: 'other-model' })).toBe('other-model');
  });

  it('gives nothing when the id is missing, empty or not a string', () => {
    for (const value of [null, undefined, 'claude-haiku-4-5', {}, { model: '' }, { model: 7 }, { model: null }]) {
      expect(modelName(value), JSON.stringify(value)).toBeNull();
    }
  });
});

describe('bootstrap wiring', () => {
  const source = readFileSync('src/scripts/bootstrap.ts', 'utf8');

  it('fetches /api/stats when idle, with the 200 ms fallback for browsers without requestIdleCallback', () => {
    expect(source).toContain("fetch('/api/stats')");
    expect(source).toContain("if ('requestIdleCallback' in window) requestIdleCallback(load);");
    expect(source).toContain('else setTimeout(load, 200);');
  });

  it('appends the readouts after the baked line only for a good answer with a usable body', () => {
    expect(source).toContain('response.ok ? response.json() : null');
    expect(source).toContain('if (readouts && text) readouts.append(` · ${text}`);');
    expect(source).not.toContain('readouts.textContent =');
  });

  it('shows the model sentence only once the name has been written into it', () => {
    expect(source).toContain('if (modelLine && modelSlot && model) {');
    expect(source).toContain('modelSlot.textContent = model;');
    expect(source).toContain('modelLine.hidden = false;');
  });
});
