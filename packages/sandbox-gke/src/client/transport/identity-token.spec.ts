import { afterEach, describe, expect, it, vi } from 'vitest';

import { identityToken, IdentityToken } from './identity-token.js';

const execFile = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFile }));

/** A JWT whose `exp` claim is `secondsFromNow` ahead. */
const jwt = (secondsFromNow: number, name = 'token'): string =>
  [
    'header',
    Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + secondsFromNow })).toString(
      'base64url',
    ),
    name,
  ].join('.');

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  execFile.mockReset();
});

describe('IdentityToken', () => {
  it('fetches a token once, and again when it is about to expire', async () => {
    vi.useFakeTimers();
    const tokens = [jwt(3600, 'first'), jwt(3600, 'second')];
    const fetchToken = vi.fn(() => tokens.shift() ?? '');
    const token = new IdentityToken(fetchToken);

    const first = await token.get();
    expect(await token.get()).toBe(first);
    vi.advanceTimersByTime(56 * 60_000);

    expect(await token.get()).not.toBe(first);
    expect(fetchToken).toHaveBeenCalledTimes(2);
  });

  it('keeps a token it cannot read the expiry of for 45 minutes', async () => {
    vi.useFakeTimers();
    const fetchToken = vi.fn(() => 'opaque');
    const token = new IdentityToken(fetchToken);

    await token.get();
    vi.advanceTimersByTime(44 * 60_000);
    await token.get();
    expect(fetchToken).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(2 * 60_000);
    await token.get();
    expect(fetchToken).toHaveBeenCalledTimes(2);
  });

  it('shares one fetch between concurrent callers', async () => {
    const fetchToken = vi.fn(() => Promise.resolve('opaque'));
    const token = new IdentityToken(fetchToken);

    await Promise.all([token.get(), token.get()]);

    expect(fetchToken).toHaveBeenCalledOnce();
  });

  it('hands out the last token at once, fetching a fresh one meanwhile', async () => {
    const token = new IdentityToken(() => Promise.resolve(' trimmed\n'));

    expect(token.current()).toBe('');
    await vi.waitFor(() => expect(token.current()).toBe('trimmed'));
  });
});

describe('identityToken', () => {
  it('has no token for a local service', () => {
    expect(identityToken('none', 'http://127.0.0.1:8080')).toBeUndefined();
  });

  it('calls a function given as the source', async () => {
    const token = identityToken(() => 'custom', 'https://service.run.app');

    expect(await token?.get()).toBe('custom');
  });

  it('asks gcloud, and says what to do when it fails', async () => {
    execFile.mockImplementationOnce(
      (_file: string, _args: string[], _options: unknown, done: (...args: unknown[]) => void) =>
        done(null, { stdout: 'from-gcloud\n' }),
    );
    const token = identityToken('gcloud', 'https://gcloud.run.app/path');

    expect(await token?.get()).toBe('from-gcloud');
    expect(identityToken('gcloud', 'https://gcloud.run.app/other')).toBe(token);
    expect(execFile).toHaveBeenCalledWith(
      'gcloud',
      ['auth', 'print-identity-token'],
      { timeout: 30_000 },
      expect.any(Function),
    );

    execFile.mockImplementationOnce(
      (_file: string, _args: string[], _options: unknown, done: (...args: unknown[]) => void) =>
        done(new Error('not logged in')),
    );
    await expect(identityToken('gcloud', 'https://other.run.app')?.get()).rejects.toThrow(
      'gcloud auth login',
    );
  });

  it('asks the metadata server for a token of the service audience', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(new Response('from-metadata')),
    );
    vi.stubGlobal('fetch', fetch);

    expect(await identityToken('metadata', 'https://metadata.run.app/x')?.get()).toBe(
      'from-metadata',
    );
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect((url as URL).searchParams.get('audience')).toBe('https://metadata.run.app');
    expect(init?.headers).toEqual({ 'metadata-flavor': 'Google' });

    fetch.mockResolvedValueOnce(new Response('', { status: 404 }));
    await expect(identityToken('metadata', 'https://refused.run.app')?.get()).rejects.toThrow(
      'refused an identity token: 404',
    );
  });
});
