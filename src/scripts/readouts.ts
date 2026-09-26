// The live values read from the /api/stats body: the two footer readouts and the model name.
// Anything but the promised shape gives null, so a failed fetch leaves the baked text alone
// rather than showing a zero that was never counted.
import type { Stats } from '../lib/ask/stats.ts';

function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

export function readoutText(body: unknown): string | null {
  if (body === null || typeof body !== 'object') return null;
  const { questionsThisMonth: questions, modelCallsThisMonth: calls, cap } = body as Partial<Stats>;
  if (!count(questions) || !count(calls) || !count(cap)) return null;
  // Cap 0 switches asking off, which is a budget fully used.
  const percent = cap === 0 ? 100 : Math.min(100, Math.round((100 * calls) / cap));
  return `${questions} ${questions === 1 ? 'question' : 'questions'} this month · AI budget ${percent}% used`;
}

export function modelName(body: unknown): string | null {
  if (body === null || typeof body !== 'object') return null;
  const { model } = body as Partial<Stats>;
  return typeof model === 'string' && model !== '' ? model : null;
}

// Where the live values go: the footer's readouts, appended to the baked line, and on the page
// that has it the model sentence, hidden until its name arrives.
export interface StatsSlots {
  readouts: Pick<Element, 'append'> | null;
  modelLine: Pick<HTMLElement, 'hidden'> | null;
  modelSlot: Pick<Element, 'textContent'> | null;
}

export function showStats(body: unknown, { readouts, modelLine, modelSlot }: StatsSlots): void {
  const text = readoutText(body);
  if (readouts && text) readouts.append(` · ${text}`);
  const model = modelName(body);
  if (modelLine && modelSlot && model) {
    modelSlot.textContent = model;
    modelLine.hidden = false;
  }
}

// Runs a task once the page is idle, or after 200 ms where requestIdleCallback does not exist, as
// in Safari.
export function whenIdle(task: () => void): void {
  if ('requestIdleCallback' in globalThis) requestIdleCallback(task);
  else setTimeout(task, 200);
}
