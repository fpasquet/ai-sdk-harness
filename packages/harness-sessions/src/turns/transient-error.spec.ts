import { describe, expect, it } from 'vitest';

import { isTransientError } from './transient-error.js';

const withCode = (message: string, code: string) => Object.assign(new Error(message), { code });
const withStatus = (message: string, statusCode: number) =>
  Object.assign(new Error(message), { statusCode });

describe('isTransientError', () => {
  it.each([
    ['a lost Claude Code bridge', new Error('claude-code bridge closed before the turn finished.')],
    ['a lost Codex bridge', new Error('codex bridge closed before the turn finished.')],
    ['a dropped connection', new Error('API Error: Connection dropped (ECONNRESET)')],
    ['a reset socket', withCode('read ECONNRESET', 'ECONNRESET')],
    ['an undici socket error', withCode('other side closed', 'UND_ERR_SOCKET')],
    ['a socket hang up', new Error('socket hang up')],
    [
      'an overloaded provider',
      new Error('API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}'),
    ],
    [
      'an internal error of the provider',
      new Error('API Error: 500 {"type":"error","error":{"type":"api_error","message":"x"}}'),
    ],
    ['a bad gateway', new Error('502 Bad Gateway')],
    ['a 503 status', withStatus('Service temporarily down', 503)],
    ['a request timeout status', withStatus('Request timed out', 408)],
    [
      'a failed fetch, from its cause',
      new Error('fetch failed', { cause: withCode('', 'ETIMEDOUT') }),
    ],
    [
      'a masked error, from its cause',
      new Error('An error occurred.', { cause: new Error('socket hang up') }),
    ],
    ['a string', 'Connection reset by peer'],
  ])('holds %s transient', (_case, error) => {
    expect(isTransientError(error)).toBe(true);
  });

  it.each([
    ['a rate limit', new Error('API Error: 429 {"error":{"type":"rate_limit_error"}}')],
    ['a usage limit', new Error('Claude AI usage limit reached|1700000000')],
    ['a subscription window', new Error("You've hit your 5-hour limit · resets 5:40pm (UTC)")],
    ['a quota, even overloaded', new Error('Quota exceeded: the service is overloaded')],
    ['refused credentials', new Error('API Error: 401 {"error":{"type":"authentication_error"}}')],
    ['an invalid API key', new Error('Invalid API key · Please run /login')],
    ['a 4xx status', withStatus('Bad request', 400)],
    ['a 429 status, though retryable for the AI SDK', withStatus('Too many requests', 429)],
    ['an abort', new DOMException('The operation was aborted.', 'AbortError')],
    ['a timeout of the caller', new DOMException('The operation timed out.', 'TimeoutError')],
    ['a turn cut short by the manager', new Error('The turn took too long.')],
    ['a number that is no status', new Error('max_tokens must be under 500 tokens')],
    ['an unknown error', new Error('Something went wrong')],
    ['nothing', undefined],
    ['null', null],
  ])('holds %s final', (_case, error) => {
    expect(isTransientError(error)).toBe(false);
  });

  it('stops reading causes that loop', () => {
    const error = new Error('outer') as Error & { cause?: unknown };
    error.cause = error;

    expect(isTransientError(error)).toBe(false);
  });
});
