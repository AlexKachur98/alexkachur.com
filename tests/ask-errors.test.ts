import { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError, RateLimitError } from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { errorType, reasonFor } from '../src/lib/ask/errors.ts';
import type { Reason } from '../src/lib/ask/errors.ts';

// Every fixture carries this token so one loop can prove that neither the reason nor the type
// string repeats any of the error text.
const SECRET = 'SECRET-DETAIL-42';
const REQUEST_ID = 'req_test';

function headers(): Headers {
  return new Headers({ 'request-id': REQUEST_ID });
}

function body(type: string, message = SECRET, details?: { error_code: string }) {
  return { type: 'error', error: { type, message, ...(details ? { details } : {}) } };
}

// generate() picks the same subclass the SDK client would throw for that status.
function api(status: number, errorBody: object): APIError {
  return APIError.generate(status, errorBody, SECRET, headers());
}

const spendLimit = { error_code: 'enforced_spend_limit_reached' };
const usageLimit = `You have reached your specified API usage limits. ${SECRET}`;
const workspaceUsageLimit = `You have reached your specified workspace API usage limits. ${SECRET}`;

const cases: { name: string; error: APIError; reason: Reason }[] = [
  { name: '401 authentication_error', error: api(401, body('authentication_error')), reason: 'config' },
  { name: '403 permission_error', error: api(403, body('permission_error')), reason: 'config' },
  { name: '404 not_found_error', error: api(404, body('not_found_error')), reason: 'config' },
  { name: '429 rate_limit_error', error: api(429, body('rate_limit_error')), reason: 'upstream' },
  { name: '429 enforced spend limit', error: api(429, body('rate_limit_error', SECRET, spendLimit)), reason: 'budget' },
  { name: '400 API usage limit', error: api(400, body('invalid_request_error', usageLimit)), reason: 'budget' },
  { name: '400 workspace API usage limit', error: api(400, body('invalid_request_error', workspaceUsageLimit)), reason: 'budget' },
  { name: '400 invalid_request_error', error: api(400, body('invalid_request_error')), reason: 'config' },
  { name: '409 conflict', error: api(409, body('api_error')), reason: 'config' },
  { name: '413 request_too_large', error: api(413, body('request_too_large')), reason: 'config' },
  { name: '422 unprocessable', error: api(422, body('invalid_request_error')), reason: 'config' },
  { name: '500 api_error', error: api(500, body('api_error')), reason: 'upstream' },
  { name: '502 bad gateway', error: api(502, body('api_error')), reason: 'upstream' },
  { name: '504 gateway timeout', error: api(504, body('api_error')), reason: 'upstream' },
  { name: '529 overloaded_error', error: api(529, body('overloaded_error')), reason: 'upstream' },
  { name: 'connection error', error: new APIConnectionError({ message: SECRET }), reason: 'upstream' },
  { name: 'connection timeout', error: new APIConnectionTimeoutError(), reason: 'upstream' },
  { name: 'user abort', error: new APIUserAbortError(), reason: 'upstream' },
  { name: '429 without a body', error: new APIError(429, undefined, SECRET, headers()), reason: 'upstream' },
];

describe('reasonFor', () => {
  it.each(cases)('$name is $reason', ({ error, reason }) => {
    expect(reasonFor(error)).toBe(reason);
  });

  it('builds the fixtures the way the SDK client throws them', () => {
    expect(api(429, body('rate_limit_error'))).toBeInstanceOf(RateLimitError);
    expect(api(429, body('rate_limit_error')).requestID).toBe(REQUEST_ID);
    expect(new APIConnectionTimeoutError().status).toBeUndefined();
    expect(new APIUserAbortError().status).toBeUndefined();
  });

  // The logged type is the class and the API's own error type, never text from the reply. The
  // reason is one of three words by its type, so only the type needs the check.
  it('logs no error text, request id or message in the error type', () => {
    for (const { error } of cases) {
      expect(error.message).not.toBe('');
      const type = errorType(error);
      expect(type).not.toContain(SECRET);
      expect(type).not.toContain(REQUEST_ID);
      expect(type).not.toContain(error.message);
    }
  });
});

describe('errorType', () => {
  it('joins the class name and the API error type', () => {
    expect(errorType(api(429, body('rate_limit_error')))).toBe('RateLimitError:rate_limit_error');
    expect(errorType(api(529, body('overloaded_error')))).toBe('InternalServerError:overloaded_error');
  });

  it('gives the class name alone when the error has no API type', () => {
    expect(errorType(new APIConnectionError({ message: SECRET }))).toBe('APIConnectionError');
    expect(errorType(new APIConnectionTimeoutError())).toBe('APIConnectionTimeoutError');
    expect(errorType(new APIError(429, undefined, SECRET, headers()))).toBe('APIError');
  });

  it('names anything that did not come from the SDK', () => {
    expect(errorType(new Error(SECRET))).toBe('Error');
    expect(errorType(new TypeError(SECRET))).toBe('TypeError');
    expect(errorType(SECRET)).toBe('string');
    expect(errorType(undefined)).toBe('undefined');
  });
});
