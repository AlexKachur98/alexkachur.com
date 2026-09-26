// The length a question may have after trimming, and reading one from a request body. No imports,
// so scripts/build-db.ts can load it without the SDK.
export const QUESTION_LENGTH = { min: 3, max: 200 } as const;

export function readQuestion(body: unknown): string | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const value = (body as { question?: unknown }).question;
  if (typeof value !== 'string') return null;
  const question = value.trim();
  return question.length >= QUESTION_LENGTH.min && question.length <= QUESTION_LENGTH.max ? question : null;
}
