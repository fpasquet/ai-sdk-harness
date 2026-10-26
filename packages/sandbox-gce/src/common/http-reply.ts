import type { ServerResponse } from 'node:http';

import { createHash, timingSafeEqual } from 'node:crypto';

import { HttpError } from './http-error.js';

/** What a route answers with: JSON, or nothing (204). */
export interface Reply {
  status: number;
  body?: unknown;
}

export const NO_CONTENT: Reply = { status: 204 };

export function send(response: ServerResponse, { status, body }: Reply): void {
  if (body === undefined) {
    response.writeHead(status).end();
    return;
  }
  response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

/**
 * Answers with the error's own status, or 500 for an error the server did not expect, which is
 * reported. A response already under way is cut.
 */
export function fail(
  response: ServerResponse,
  error: unknown,
  report: (message: string) => void,
): void {
  const known = error instanceof HttpError;
  const message = error instanceof Error ? error.message : String(error);
  if (!known) report(message);
  if (response.headersSent) response.destroy();
  else send(response, { status: known ? error.status : 500, body: { error: message } });
}

/** Compares a secret in constant time: how long it takes says nothing of the expected one. */
export function sameSecret(given: string | string[] | undefined, expected: string): boolean {
  if (typeof given !== 'string') return false;
  const digest = (value: string): Buffer => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(given), digest(expected));
}

/** The bearer token of an `Authorization` header, if it carries one. */
export function bearer(header: string | undefined): string | undefined {
  // No regular expression past the scheme: one over the token backtracks on a run of spaces.
  if (header === undefined || !/^Bearer\s/i.test(header)) return undefined;
  const token = header.slice('Bearer'.length).trim();
  return token === '' ? undefined : token;
}

/** Waits for `exited`, `waitMs` at most: its exit code, or that the process still runs. */
export async function waitForExit(exited: Promise<number>, waitMs: number): Promise<Reply> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(resolve, waitMs, undefined);
  });
  const exitCode = await Promise.race([exited, timeout]);
  clearTimeout(timer);
  return { status: 200, body: exitCode === undefined ? { running: true } : { exitCode } };
}
