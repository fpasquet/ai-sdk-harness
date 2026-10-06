import { execFile } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import { ExitCodeCarrier } from './exit-code-carrier.js';

/** Runs `command` under the carrier, as the CLI runtime does, and reads it back. */
async function run(
  command: string,
): Promise<{ exitCode?: number; shellCode: number; stderr: string }> {
  const carrier = new ExitCodeCarrier();
  const [shell = '', ...args] = carrier.command(['/bin/sh', '-c', command]);
  const child = execFile(shell, args, { encoding: 'buffer' }, () => undefined);
  const chunks: Buffer[] = [];
  carrier.on('data', (chunk: Buffer) => chunks.push(chunk));
  const finished = new Promise<void>((resolve) => carrier.once('finish', resolve));
  const closed = new Promise<number>((resolve) =>
    child.once('close', (code) => resolve(code ?? -1)),
  );
  child.stderr?.pipe(carrier);
  const [shellCode] = await Promise.all([closed, finished]);
  return { stderr: Buffer.concat(chunks).toString(), exitCode: carrier.exitCode, shellCode };
}

describe('the exit code carrier', () => {
  it('brings back the code of a failed command, while the shell succeeds', async () => {
    expect(await run('echo oops >&2; exit 44')).toEqual({
      stderr: 'oops\n',
      exitCode: 44,
      shellCode: 0,
    });
  });

  it('brings back 0, and leaves an error stream without a newline as it was', async () => {
    expect(await run('printf "no newline" >&2')).toEqual({
      stderr: 'no newline',
      exitCode: 0,
      shellCode: 0,
    });
  });

  it('passes on a large error stream whole', async () => {
    const { stderr, exitCode } = await run('head -c 200000 /dev/zero | tr "\\0" x >&2; exit 3');

    expect(stderr).toHaveLength(200_000);
    expect(exitCode).toBe(3);
  });

  it('leaves the stream as it is when the marker never comes', async () => {
    const carrier = new ExitCodeCarrier();
    const chunks: Buffer[] = [];
    carrier.on('data', (chunk: Buffer) => chunks.push(chunk));
    const finished = new Promise((resolve) => carrier.once('finish', resolve));

    carrier.end('killed before it could report');
    await finished;

    expect(Buffer.concat(chunks).toString()).toBe('killed before it could report');
    expect(carrier.exitCode).toBeUndefined();
  });
});
