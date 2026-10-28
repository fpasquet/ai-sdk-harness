import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';

import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { Readable } from 'node:stream';
import { setTimeout as wait } from 'node:timers/promises';

import { SbxError } from '../errors/sbx-error.js';
import { SbxNotSignedInError } from '../errors/sbx-not-signed-in-error.js';
import { SbxTimeoutError } from '../errors/sbx-timeout-error.js';
import { abortReason } from '../utils/abort.js';

/** What a finished `sbx` invocation left behind. */
export interface SbxResult {
  exitCode: number;
  /** Kept as bytes: `sbx exec … cat` hands back a file, which need not be text. */
  stdout: Buffer;
  stderr: string;
}

export interface SbxCallOptions {
  /** Written to the command's stdin, which is then closed; `'open'` leaves it to the caller. */
  stdin?: 'open' | ReadableStream<Uint8Array> | Uint8Array;
  /**
   * Variables the `sbx` client itself sees, on top of this process's environment. `sbx exec -e NAME`
   * without a value forwards the client's own `NAME` into the sandbox, so a value never has to
   * appear on a command line.
   */
  env?: Record<string, string>;
  abortSignal?: AbortSignal;
  /**
   * The command may take long by nature, creating a sandbox, its setup, a file: no deadline, only
   * `abortSignal`. Every other command is stopped after the CLI's `commandTimeoutMs`.
   */
  unbounded?: boolean;
  /**
   * The command only reads (`ls`, `template ls`…) and may run again: past its deadline, or when
   * `sbx` answers that the Docker sign-in service is unavailable, it is retried after a pause. A
   * busy or briefly unreachable `sandboxd` then delays a session instead of failing it.
   */
  retry?: boolean;
}

/** How long a control command of `sbx` (`ls`, `ports`, `stop`, a probe…) may take by default. */
export const COMMAND_TIMEOUT_MS = 60_000;
/** How long the commands of a sandbox fail at once after `sbx` was found signed out. */
const SIGNED_OUT_HOLD_MS = 30_000;
/**
 * What `sbx` prints when it is signed out of Docker or its sign-in expired: its own hint, and the
 * Docker sign-in service's refusal. Read on the commands this package runs, never on an agent's.
 */
const SIGNED_OUT = /^\s*try: sbx login\s*$|please sign in to Docker|no valid user session found/im;
/**
 * What `sandboxd` answers while it cannot refresh its Docker session for a moment (its host's
 * keyring did not reply, the sign-in service is down): worth asking again, unlike a sign-out.
 */
const UNAVAILABLE = /docker login service unavailable|503 Service Unavailable/i;
/** The pauses before each new try of a command that may run again: two more tries in all. */
const RETRY_DELAYS_MS = [2_000, 5_000];

export interface SbxCliOptions {
  /** See {@link COMMAND_TIMEOUT_MS}. */
  commandTimeoutMs?: number;
  /** See {@link SIGNED_OUT_HOLD_MS}. */
  signedOutHoldMs?: number;
  /** See {@link RETRY_DELAYS_MS}. */
  retryDelaysMs?: readonly number[];
}

const exitCodeOf = (code: null | number, signal: NodeJS.Signals | null): number =>
  code ?? (signal === null ? 0 : 128 + (constants.signals[signal] ?? 0));

/**
 * The `sbx` command line of Docker Sandboxes, run as a child process: the only way this package
 * reaches a sandbox. Every argument is passed as-is, never through a host shell.
 */
export class SbxCli {
  readonly commandTimeoutMs: number;
  private readonly signedOutHoldMs: number;
  private readonly retryDelaysMs: readonly number[];
  /** When `sbx` was last found signed out, and what it said: the next commands fail at once. */
  private signedOut: undefined | { at: number; stderr: string };

  /**
   * @param binary The `sbx` binary.
   * @param cloud Address Docker Sandboxes Cloud rather than this host's sandboxes: every command
   *   goes out as `sbx --cloud …`.
   */
  constructor(
    readonly binary = 'sbx',
    readonly cloud = false,
    {
      commandTimeoutMs = COMMAND_TIMEOUT_MS,
      signedOutHoldMs = SIGNED_OUT_HOLD_MS,
      retryDelaysMs = RETRY_DELAYS_MS,
    }: SbxCliOptions = {},
  ) {
    this.commandTimeoutMs = commandTimeoutMs;
    this.signedOutHoldMs = signedOutHoldMs;
    this.retryDelaysMs = retryDelaysMs;
  }

  /**
   * Starts `sbx` and hands back the running process, streams untouched. Neither bounded nor read:
   * it runs what the caller asked for, as long as the caller wants.
   */
  start(args: readonly string[], options: SbxCallOptions = {}): ChildProcessWithoutNullStreams {
    this.assertSignedIn(args);
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
    } else if (stdin === 'open') {
      // Written and closed by the caller.
    } else if (stdin instanceof Uint8Array) {
      child.stdin.end(stdin);
    } else {
      Readable.fromWeb(stdin as NodeReadableStream<Uint8Array>).pipe(child.stdin);
    }
    return child;
  }

  /**
   * Runs `sbx` to completion, whatever its exit code. Throws {@link SbxTimeoutError} past its
   * deadline, and {@link SbxNotSignedInError} when `sbx` is signed out.
   */
  async run(args: readonly string[], options: SbxCallOptions = {}): Promise<SbxResult> {
    if (options.abortSignal?.aborted) throw abortReason(options.abortSignal);
    const result = await this.attempt(args, options);
    if (result.exitCode !== 0 && SIGNED_OUT.test(result.stderr)) {
      this.signedOut = { at: Date.now(), stderr: result.stderr };
      throw new SbxNotSignedInError(args, result);
    }
    this.signedOut = undefined;
    return result;
  }

  /** Runs `sbx` and returns its standard output as text, throwing {@link SbxError} on failure. */
  async check(args: readonly string[], options: SbxCallOptions = {}): Promise<string> {
    const result = await this.run(args, options);
    if (result.exitCode !== 0) throw new SbxError(args, result);
    return result.stdout.toString();
  }

  /**
   * Runs `sbx` once, or, for a command that may run again, until it answers, at most once more for
   * each of the retry delays.
   */
  private async attempt(args: readonly string[], options: SbxCallOptions): Promise<SbxResult> {
    for (const delay of options.retry ? this.retryDelaysMs : []) {
      try {
        const result = await this.collect(args, options);
        if (result.exitCode === 0 || !UNAVAILABLE.test(result.stderr)) return result;
      } catch (error) {
        if (!(error instanceof SbxTimeoutError)) throw error;
      }
      await wait(delay, undefined, { signal: options.abortSignal });
    }
    return this.collect(args, options);
  }

  /** Fails at once while `sbx` was found signed out a moment ago: it would only fail, or hang. */
  private assertSignedIn(args: readonly string[]): void {
    if (this.signedOut === undefined) return;
    if (Date.now() - this.signedOut.at >= this.signedOutHoldMs) return;
    throw new SbxNotSignedInError(args, { exitCode: 1, stderr: this.signedOut.stderr });
  }

  /** Runs `sbx`, its output kept, killed past its deadline unless the call is unbounded. */
  private collect(args: readonly string[], options: SbxCallOptions): Promise<SbxResult> {
    const child = this.start(args, options);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    return new Promise((resolve, reject) => {
      let timedOut = false;
      const deadline = options.unbounded
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
          reject(new SbxTimeoutError(args, errors, this.commandTimeoutMs));
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

  private notFound(): Error {
    return new Error(
      `The Docker Sandboxes CLI \`${this.binary}\` was not found. Install it ` +
        '(https://docs.docker.com/ai/sandboxes/get-started/) or point the `binary` option at it.',
    );
  }
}
