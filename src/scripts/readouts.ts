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
