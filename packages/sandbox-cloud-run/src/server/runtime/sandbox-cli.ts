import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

import { spawn } from 'node:child_process';

import { ExitCodeCarrier } from './exit-code-carrier.js';
import { SandboxCliError } from './sandbox-cli-error.js';

/** A process running in a sandbox. */
export interface RuntimeProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  /** Its exit code, once it is over: 137 when it was stopped from outside. */
  readonly exited: Promise<number>;
  /** Stops the `sandbox exec` that runs it: the process in the sandbox may outlive it. */
  kill(): void;
}

/**
 * Cloud Run's sandboxes (https://docs.cloud.google.com/run/docs/reference/sandbox-cli), through
 * the `sandbox` command line Cloud Run puts in the instances of a service deployed with
 * `--sandbox-launcher`: Cloud Run has no API for its sandboxes. A sandbox's root is the service's
 * own image, read-only, under a writable layer of its own: that layer is what a snapshot saves and
 * what a new sandbox can start from.
 *
 * Every argument is passed as is, never through a shell. The CLI runs with the service's
 * variables, which hold no secret, and a sandbox inherits none of them.
 */
export class SandboxCli {
  /**
   * @param binary The `sandbox` CLI.
   * @param allowEgress Give each sandbox a network of its own (`--allow-egress`), beside its relay.
   */
  constructor(
    private readonly binary: string,
    private readonly allowEgress = false,
  ) {}

  /** Starts the sandbox `name`, idle, its writable layer the tar `snapshot` when given. */
  async create(name: string, snapshot?: string): Promise<void> {
    await this.check([
      'run',
      name,
      '--detach',
      // The root is the image, read-only; the sandbox writes on a layer of its own.
      '--write',
      ...(this.allowEgress ? ['--allow-egress'] : []),
      ...(snapshot === undefined ? [] : [`--import-tar=${snapshot}`]),
      '--',
      '/bin/sleep',
      'infinity',
    ]);
  }

  /**
   * Starts `argv` in the sandbox, under {@link ExitCodeCarrier}: the CLI loses the exit codes of
   * what it runs. Its standard streams are the caller's to read and write.
   */
  exec(name: string, argv: readonly string[]): RuntimeProcess {
    const carrier = new ExitCodeCarrier();
    const child = this.start(['exec', name, '--', ...carrier.command(argv)]);
    child.stderr.pipe(carrier);
    const closed = new Promise<number>((resolve) => {
      child.once('error', () => resolve(127));
      child.once('close', (code) => resolve(code ?? 137));
    });
    const finished = new Promise<void>((resolve) => carrier.once('finish', resolve));
    const exited = Promise.all([closed, finished]).then(
      ([code]) => carrier.exitCode ?? (code === 0 ? 137 : code),
    );
    return {
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: carrier,
      exited,
      kill: () => child.kill(),
    };
  }

  /** Writes the sandbox's writable layer to `file`, as a tar. */
  async snapshot(name: string, file: string): Promise<void> {
    await this.check(['tar', name, `--file=${file}`]);
  }

  /** Deletes the sandbox, and whatever runs in it. */
  async delete(name: string): Promise<void> {
    await this.check(['delete', name, '--force']);
  }

  private start(args: readonly string[]): ChildProcessWithoutNullStreams {
    const child = spawn(this.binary, args, { stdio: 'pipe' });
    // A command that exits before reading its stdin must not crash the service on EPIPE.
    child.stdin.on('error', () => undefined);
    return child;
  }

  /** Runs the CLI to completion, stdin closed, and throws unless it exits with 0. */
  private check(args: readonly string[]): Promise<void> {
    const child = this.start(args);
    child.stdin.end();
    child.stdout.resume();
    const stderr: Buffer[] = [];
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    return new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => {
        if (code === 0) resolve();
        else reject(new SandboxCliError(args, code ?? 1, Buffer.concat(stderr).toString()));
      });
    });
  }
}
