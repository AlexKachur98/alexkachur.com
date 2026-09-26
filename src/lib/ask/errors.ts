// The reason the visitor is given for an API failure: config for a wrong key or a forbidden or
// retired model, budget for a spend limit, upstream for anything transient, the deadline included.
import { APIError } from '@anthropic-ai/sdk';

export type Reason = 'config' | 'budget' | 'upstream';

interface ErrorBody {
  error?: { type?: string; message?: string; details?: { error_code?: string } };
}

export function reasonFor(error: APIError): Reason {
  const body = (error.error ?? {}) as ErrorBody;
  const { status } = error;
  if (status === undefined) return 'upstream';
  if (status === 401 || status === 403 || status === 404) return 'config';
  if (status === 429) return body.error?.details?.error_code === 'enforced_spend_limit_reached' ? 'budget' : 'upstream';
  // A spend limit set in the Console answers 400 with this sentence (a workspace limit says
  // "specified workspace API usage limits"); any other 400 means the request itself is wrong.
  if (status === 400) return (body.error?.message ?? '').startsWith('You have reached your specified') ? 'budget' : 'config';
  if (status >= 500) return 'upstream';
  return 'config';
}

// The class name, plus the API's own error type when there is one, for the log line.
export function errorType(error: unknown): string {
  if (error instanceof APIError) return error.type ? `${error.constructor.name}:${error.type}` : error.constructor.name;
  if (error instanceof Error) return error.constructor.name;
  return typeof error;
}
