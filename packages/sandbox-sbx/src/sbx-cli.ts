import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';

import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { Readable } from 'node:stream';

import { SbxError } from './sbx-error.js';

/** What a finished `sbx` invocation left behind. */
export interface SbxResult {
  exitCode: number;
  /** Kept as bytes: `sbx exec … cat` hands back a file, which need not be text. */
  stdout: Buffer;
  stderr: string;
}

export interface SbxCallOptions {
  /** Written to the command's stdin, which is then closed. */
  stdin?: ReadableStream<Uint8Array> | Uint8Array;
  /**
   * Variables the `sbx` client itself sees, on top of this process's environment. `sbx exec -e NAME`
   * without a value forwards the client's own `NAME` into the sandbox, so a value never has to
   * appear on a command line.
   */
  env?: Record<string, string>;
  abortSignal?: AbortSignal;
}

/** Why `signal` was aborted, as an error to reject with. */
export const abortReason = (signal: AbortSignal): Error => {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new DOMException('Aborted', 'AbortError');
};

const exitCodeOf = (code: null | number, signal: NodeJS.Signals | null): number =>
  code ?? (signal === null ? 0 : 128 + (constants.signals[signal] ?? 0));

/**
 * The `sbx` command line of Docker Sandboxes, run as a child process: the only way this package
 * reaches a sandbox. Every argument is passed as-is, never through a host shell.
 */
export class SbxCli {
  /**
   * @param binary The `sbx` binary.
   * @param cloud Address Docker Sandboxes Cloud rather than this host's sandboxes: every command
   *   goes out as `sbx --cloud …`.
   */
  constructor(
    readonly binary = 'sbx',
    readonly cloud = false,
  ) {}

  /** Starts `sbx` and hands back the running process, streams untouched. */
  start(args: readonly string[], options: SbxCallOptions = {}): ChildProcessWithoutNullStreams {
    const child = spawn(this.binary, this.cloud ? ['--cloud', ...args] : args, {
      env: { ...process.env, ...options.env },
      signal: options.abortSignal,
      stdio: 'pipe',
    });
    // A command that exits before reading its stdin must not crash this process on EPIPE.
    child.stdin.on('error', () => undefined);
    const { stdin } = options;
    if (stdin === undefined) {
      child.stdin.end();
    } else if (stdin instanceof Uint8Array) {
      child.stdin.end(stdin);
    } else {
      Readable.fromWeb(stdin as NodeReadableStream<Uint8Array>).pipe(child.stdin);
    }
    return child;
  }

  /** Runs `sbx` to completion, whatever its exit code. */
  run(args: readonly string[], options: SbxCallOptions = {}): Promise<SbxResult> {
    if (options.abortSignal?.aborted) return Promise.reject(abortReason(options.abortSignal));
    const child = this.start(args, options);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    return new Promise((resolve, reject) => {
      child.once('error', (error: NodeJS.ErrnoException) =>
        reject(error.code === 'ENOENT' ? this.notFound() : error),
      );
      child.once('close', (code, signal) =>
        resolve({
          exitCode: exitCodeOf(code, signal),
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr).toString(),
        }),
      );
    });
  }

  /** Runs `sbx` and returns its standard output as text, throwing {@link SbxError} on failure. */
  async check(args: readonly string[], options: SbxCallOptions = {}): Promise<string> {
    const result = await this.run(args, options);
    if (result.exitCode !== 0) throw new SbxError(args, result);
    return result.stdout.toString();
  }

  private notFound(): Error {
    return new Error(
      `The Docker Sandboxes CLI \`${this.binary}\` was not found. Install it ` +
        '(https://docs.docker.com/ai/sandboxes/get-started/) or point the `binary` option at it.',
    );
  }
}
