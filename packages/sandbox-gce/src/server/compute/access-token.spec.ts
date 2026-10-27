import { afterEach, describe, expect, it, vi } from 'vitest';

import { AccessToken } from './access-token.js';

const execFile = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({ execFile }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  execFile.mockReset();
});

const tokenResponse = (value: string): Response =>
  Response.json({ access_token: value, expires_in: 3600 });

describe('the access tokens of the Compute Engine calls', () => {
  it('has none for the fake API', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');

    await expect(new AccessToken('none').get()).resolves.toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('gets a token from the metadata server once, and again before it expires', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(tokenResponse('first'))
      .mockResolvedValueOnce(tokenResponse('second'));
    const token = new AccessToken('metadata');

    const [one, two] = await Promise.all([token.get(), token.get()]);
    const kept = await token.get();
    vi.advanceTimersByTime(56 * 60_000);
    const renewed = await token.get();

    expect([one, two, kept, renewed]).toEqual(['first', 'first', 'first', 'second']);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('metadata.google.internal'),
      expect.objectContaining({ headers: { 'metadata-flavor': 'Google' } }),
    );
  });

  it('says when the metadata server refuses a token', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('no', { status: 403 }));

    await expect(new AccessToken('metadata').get()).rejects.toThrow(
      'The metadata server refused an access token: 403',
    );
  });

  it('gets a token from the gcloud CLI off Google Cloud', async () => {
    execFile.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: unknown,
        callback: (error: null, output: { stdout: string; stderr: string }) => void,
      ) => {
        callback(null, { stdout: 'ya29.token\n', stderr: '' });
      },
    );

    await expect(new AccessToken('gcloud').get()).resolves.toBe('ya29.token');
    expect(execFile).toHaveBeenCalledWith(
      'gcloud',
      ['auth', 'print-access-token'],
      { timeout: 30_000 },
      expect.any(Function),
    );
  });
});
