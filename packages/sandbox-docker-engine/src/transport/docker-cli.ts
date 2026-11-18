import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';

import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { Readable } from 'node:stream';

import { DockerEngineError } from '../errors/docker-engine-error.js';
import { abortReason } from '../utils/abort.js';

/** What a finished `docker` invocation left behind. */
export interface DockerResult {
  exitCode: number;
  /** Kept as bytes: `docker exec … cat` hands back a file, which need not be text. */
  stdout: Buffer;
  stderr: string;
}

export interface DockerCallOptions {
  /** Written to the command's stdin, which is then closed; `'open'` leaves it to the caller. */
  stdin?: 'open' | ReadableStream<Uint8Array> | Uint8Array;
  /**
   * Variables the `docker` client itself sees, on top of this process's environment. `docker exec
   * -e NAME` without a value forwards the client's own `NAME`, so that a value never has to appear
   * on a command line.
   */
  env?: Record<string, string>;
  abortSignal?: AbortSignal;
  /** The command may take long by nature, pulling an image, a file: no deadline. */
  unbounded?: boolean;
}

/** How long a control command of `docker` (`inspect`, `stop`, `port`…) may take by default. */
export const COMMAND_TIMEOUT_MS = 60_000;

const exitCodeOf = (code: null | number, signal: NodeJS.Signals | null): number =>
  code ?? (signal === null ? 0 : 128 + (constants.signals[signal] ?? 0));

/**
 * The `docker` command line, run as a child process: the only way this package reaches Docker
 * Engine. Every argument is passed as it is, never through a host shell.
 */
export class DockerCli {
  constructor(
    readonly binary = 'docker',
    readonly commandTimeoutMs = COMMAND_TIMEOUT_MS,
  ) {}

  /** Starts `docker` and hands back the running process, streams untouched. */
  start(args: readonly string[], options: DockerCallOptions = {}): ChildProcessWithoutNullStreams {
    const child = spawn(this.binary, args, {
      env: { ...process.env, ...options.env },
      signal: options.abortSignal,
      stdio: 'pipe',
    });
    // A command that exits before reading its stdin must not crash this process on EPIPE.
    child.stdin.on('error', () => undefined);
    const { stdin } = options;
    if (stdin === undefined) child.stdin.end();
    else if (stdin instanceof Uint8Array) child.stdin.end(stdin);
    else if (stdin !== 'open') {
      Readable.fromWeb(stdin as NodeReadableStream<Uint8Array>).pipe(child.stdin);
    }
    return child;
  }

  /** Runs `docker` to completion, whatever its exit code; killed past its deadline. */
  async run(args: readonly string[], options: DockerCallOptions = {}): Promise<DockerResult> {
    if (options.abortSignal?.aborted === true) throw abortReason(options.abortSignal);
    const child = this.start(args, options);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    return new Promise((resolve, reject) => {
      let timedOut = false;
      const deadline =
        options.unbounded === true
          ? undefined
          : setTimeout(() => {
              timedOut = true;
              child.kill('SIGKILL');
            }, this.commandTimeoutMs);
      child.once('error', (error: NodeJS.ErrnoException) => {
        clearTimeout(deadline);
        reject(error.code === 'ENOENT' ? this.notFound() : error);
      });
      child.once('close', (code, signal) => {
        clearTimeout(deadline);
        const errors = Buffer.concat(stderr).toString();
        if (timedOut) {
          reject(
            new DockerEngineError(
              args,
              { exitCode: 124, stderr: errors },
              `\`docker ${args[0] ?? ''}\` took longer than ${this.commandTimeoutMs} ms.`,
            ),
          );
          return;
        }
        resolve({
          exitCode: exitCodeOf(code, signal),
          stdout: Buffer.concat(stdout),
          stderr: errors,
        });
      });
    });
  }

  /** Runs `docker` and returns its standard output as text, throwing on a non-zero exit. */
  async check(args: readonly string[], options: DockerCallOptions = {}): Promise<string> {
    const result = await this.run(args, options);
    if (result.exitCode !== 0) throw new DockerEngineError(args, result);
    return result.stdout.toString();
  }

  private notFound(): Error {
    return new Error(
      `The Docker CLI \`${this.binary}\` was not found. Install Docker Engine ` +
        '(https://docs.docker.com/engine/install/) or point the `binary` option at it.',
    );
  }
}
