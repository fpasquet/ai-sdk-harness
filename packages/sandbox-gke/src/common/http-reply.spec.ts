import type { ServerResponse } from 'node:http';

import { describe, expect, it, vi } from 'vitest';

import { HttpError } from './http-error.js';
import { bearer, fail, sameSecret, send, waitForExit } from './http-reply.js';

/** A response that records what it was told. */
function responseOf(headersSent = false) {
  const response = {
    headersSent,
    writeHead: vi.fn(() => response),
    end: vi.fn(() => response),
    destroy: vi.fn(),
  };
  return response;
}

const asResponse = (response: ReturnType<typeof responseOf>): ServerResponse =>
  response as unknown as ServerResponse;

describe('the replies of the servers', () => {
  it('sends JSON, or nothing', () => {
    const json = responseOf();
    const empty = responseOf();

    send(asResponse(json), { status: 200, body: { ok: true } });
    send(asResponse(empty), { status: 204 });

    expect(json.writeHead).toHaveBeenCalledWith(200, { 'content-type': 'application/json' });
    expect(json.end).toHaveBeenCalledWith('{"ok":true}');
    expect(empty.writeHead).toHaveBeenCalledWith(204);
  });

  it('answers a known error with its status, and reports any other as a 500', () => {
    const report = vi.fn();
    const known = responseOf();
    const unknown = responseOf();

    fail(asResponse(known), new HttpError(404, 'gone'), report);
    fail(asResponse(unknown), 'broken', report);

    expect(known.writeHead).toHaveBeenCalledWith(404, expect.anything());
    expect(unknown.writeHead).toHaveBeenCalledWith(500, expect.anything());
    expect(unknown.end).toHaveBeenCalledWith('{"error":"broken"}');
    expect(report).toHaveBeenCalledExactlyOnceWith('broken');
  });

  it('cuts a response already under way', () => {
    const response = responseOf(true);

    fail(asResponse(response), new HttpError(400, 'late'), () => undefined);

    expect(response.destroy).toHaveBeenCalled();
    expect(response.writeHead).not.toHaveBeenCalled();
  });

  it('compares secrets, and refuses a missing one', () => {
    expect(sameSecret('token', 'token')).toBe(true);
    expect(sameSecret('other', 'token')).toBe(false);
    expect(sameSecret(undefined, 'token')).toBe(false);
    expect(sameSecret(['token'], 'token')).toBe(false);
  });

  it('reads the bearer token of a header, and nothing else', () => {
    expect(bearer('Bearer  abc ')).toBe('abc');
    expect(bearer('bearer abc')).toBe('abc');
    expect(bearer('Bearer ')).toBeUndefined();
    expect(bearer('Basic abc')).toBeUndefined();
    expect(bearer('Bearerabc')).toBeUndefined();
    expect(bearer(undefined)).toBeUndefined();
  });

  it('reads a header of many spaces at once', () => {
    const started = performance.now();

    expect(bearer(`Bearer ${' '.repeat(100_000)}x`)).toBe('x');
    expect(bearer(`Bearer ${' '.repeat(100_000)}`)).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(100);
  });

  it('waits for an exit code, or says the process still runs', async () => {
    await expect(waitForExit(Promise.resolve(3), 1000)).resolves.toEqual({
      status: 200,
      body: { exitCode: 3 },
    });
    await expect(waitForExit(new Promise<number>(() => undefined), 1)).resolves.toEqual({
      status: 200,
      body: { running: true },
    });
  });
});
