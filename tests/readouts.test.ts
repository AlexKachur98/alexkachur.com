import { afterEach, describe, expect, it, vi } from 'vitest';
import { modelName, readoutText, showStats, whenIdle } from '../src/scripts/readouts.ts';
import type { StatsSlots } from '../src/scripts/readouts.ts';

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

describe('showStats', () => {
  function slots() {
    const appended: string[] = [];
    const modelLine = { hidden: true as HTMLElement['hidden'] };
    const modelSlot = { textContent: '' };
    const slots: StatsSlots = { readouts: { append: (...nodes) => void appended.push(nodes.join('')) }, modelLine, modelSlot };
    return { appended, modelLine, modelSlot, slots };
  }

  it('appends the readouts after the built line, and names the model and shows its sentence', () => {
    const page = slots();
    showStats({ ...body(12, 500, 2000), model: 'claude-haiku-4-5' }, page.slots);
    expect(page.appended).toEqual([' · 12 questions this month · AI budget 25% used']);
    expect(page.modelSlot.textContent).toBe('claude-haiku-4-5');
    expect(page.modelLine.hidden).toBe(false);
  });

  it('leaves the page as built for a body without the promised values', () => {
    for (const value of [null, {}, body('12', 500, 2000)]) {
      const page = slots();
      showStats(value, page.slots);
      expect(page.appended, JSON.stringify(value)).toEqual([]);
      expect(page.modelLine.hidden).toBe(true);
    }
  });
});

describe('whenIdle', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('waits for the page to be idle where the browser can say so', () => {
    const idle = vi.fn();
    vi.stubGlobal('requestIdleCallback', idle);
    const task = () => {};
    whenIdle(task);
    expect(idle).toHaveBeenCalledWith(task);
  });

  it('waits 200 ms where requestIdleCallback does not exist, as in Safari', () => {
    vi.useFakeTimers();
    const task = vi.fn();
    whenIdle(task);
    vi.advanceTimersByTime(199);
    expect(task).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(task).toHaveBeenCalledOnce();
  });
});
