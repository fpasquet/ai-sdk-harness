import type {
  Experimental_SandboxProcess as SandboxProcess,
  Experimental_SandboxSession as SandboxSession,
} from '@ai-sdk/provider-utils';

import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { Readable } from 'node:stream';

import type { SbxCli } from './sbx-cli.js';

import {
  KILL_TREE,
  PROCESS_DIR,
  READ,
  READ_DIRECTORY,
  READ_MISSING,
  TRACKED,
  WRITE,
} from './sandbox-scripts.js';
import { abortReason } from './sbx-cli.js';

type ProcessOptions = Parameters<SandboxSession['spawn']>[0];
type ReadOptions = Parameters<SandboxSession['readFile']>[0];
type ReadTextOptions = Parameters<SandboxSession['readTextFile']>[0];
type WriteOptions = Parameters<SandboxSession['writeFile']>[0];
type WriteBinaryOptions = Parameters<SandboxSession['writeBinaryFile']>[0];
type WriteTextOptions = Parameters<SandboxSession['writeTextFile']>[0];

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** What every view of one sandbox shares: its name, the CLI that reaches it, its processes. */
export interface SbxSandboxHandle {
  readonly cli: SbxCli;
  /** The sandbox's name in `sbx ls`. */
  readonly name: string;
  /** The sandbox's own working directory, which relative paths resolve against. */
  readonly workingDirectory: string;
  /** Pid files of the processes spawned and not yet exited. */
  readonly processes: Set<string>;
  /** Variables of the sandbox's own environment dropped from every command that does not set them. */
  readonly clearEnv: readonly string[];
}

/** Throws unless every key of `env` can be forwarded as a bare `sbx exec -e NAME`. */
export function assertEnvNames(names: Iterable<string>): void {
  for (const name of names) {
    if (!ENV_NAME.test(name)) throw new Error(`Not an environment variable name: ${name}`);
  }
}

/**
 * The file and process surface of a Docker Sandbox: what a harness hands to its tools. Every call
 * is an `sbx exec` into the sandbox's microVM: nothing runs on the host, and only the variables a
 * command names are forwarded, never this process's environment.
 */
export class SbxSandboxSession implements SandboxSession {
  constructor(protected readonly handle: SbxSandboxHandle) {}

  get description(): string {
    return [
      `Docker Sandbox "${this.handle.name}": a microVM with a filesystem of its own, working directory ${this.handle.workingDirectory}.`,
      'Outbound traffic goes through the Docker Sandboxes proxy and its network policy.',
    ].join('\n');
  }

  run = async (
    options: ProcessOptions,
  ): Promise<{ exitCode: number; stderr: string; stdout: string }> => {
    const spawned = await this.spawn(options);
    const [stdout, stderr, { exitCode }] = await Promise.all([
      new Response(spawned.stdout).text(),
      new Response(spawned.stderr).text(),
      spawned.wait(),
    ]);
    return { exitCode, stdout, stderr };
  };

  spawn = (options: ProcessOptions): Promise<SandboxProcess> => {
    try {
      return Promise.resolve(this.start(options));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  };

  /** Starts `command` in the sandbox, its pid recorded so it can be stopped from outside. */
  private start({
    command,
    workingDirectory,
    env = {},
    abortSignal,
  }: ProcessOptions): SandboxProcess {
    if (abortSignal?.aborted) throw abortReason(abortSignal);
    assertEnvNames(Object.keys(env));
    const pidFile = `${PROCESS_DIR}/${randomUUID()}`;
    const cleared = this.handle.clearEnv.filter((name) => !(name in env));
    const script = cleared.length > 0 ? `unset ${cleared.join(' ')}; ${TRACKED}` : TRACKED;
    const child = this.handle.cli.start(
      [...this.execArgs({ workingDirectory, env }), 'sh', '-c', script, pidFile, command],
      { env },
    );
    this.handle.processes.add(pidFile);

    let killed: Promise<void> | undefined;
    const kill = (): Promise<void> => {
      killed ??= this.killTree(pidFile).finally(() => child.kill());
      return killed;
    };
    const onAbort = (): void => void kill();
    abortSignal?.addEventListener('abort', onAbort, { once: true });

    const exited = new Promise<{ exitCode: number }>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => {
        this.handle.processes.delete(pidFile);
        abortSignal?.removeEventListener('abort', onAbort);
        if (abortSignal?.aborted) {
          reject(abortReason(abortSignal));
        } else {
          resolve({ exitCode: code ?? 137 });
        }
      });
    });
    // `wait()` may never be called; an unobserved rejection must not take the process down.
    exited.catch(() => undefined);

    return {
      stdout: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      stderr: Readable.toWeb(child.stderr) as ReadableStream<Uint8Array>,
      wait: () => exited,
      kill,
    };
  }

  readBinaryFile = async ({ path, abortSignal }: ReadOptions): Promise<null | Uint8Array> => {
    const target = this.resolve(path);
    const result = await this.handle.cli.run([...this.execArgs({}), 'sh', '-c', READ, target], {
      abortSignal,
    });
    if (result.exitCode === READ_MISSING) return null;
    if (result.exitCode === READ_DIRECTORY) {
      throw Object.assign(new Error(`EISDIR: illegal operation on a directory, read '${target}'`), {
        code: 'EISDIR',
      });
    }
    if (result.exitCode !== 0) {
      throw new Error(`Could not read ${target} in the sandbox: ${result.stderr.trim()}`);
    }
    return new Uint8Array(result.stdout);
  };

  readFile = async (options: ReadOptions): Promise<null | ReadableStream<Uint8Array>> => {
    const bytes = await this.readBinaryFile(options);
    return bytes === null ? null : new Blob([bytes as Uint8Array<ArrayBuffer>]).stream();
  };

  readTextFile = async ({
    encoding = 'utf-8',
    startLine,
    endLine,
    ...options
  }: ReadTextOptions): Promise<null | string> => {
    const bytes = await this.readBinaryFile(options);
    if (bytes === null) return null;
    const text = Buffer.from(bytes).toString(encoding as BufferEncoding);
    if (startLine === undefined && endLine === undefined) return text;
    return text
      .split('\n')
      .slice((startLine ?? 1) - 1, endLine)
      .join('\n');
  };

  writeFile = async ({ path, content, abortSignal }: WriteOptions): Promise<void> => {
    const target = this.resolve(path);
    const result = await this.handle.cli.run(
      [...this.execArgs({ stdin: true }), 'sh', '-c', WRITE, target],
      { stdin: content, abortSignal },
    );
    if (result.exitCode !== 0) {
      throw new Error(`Could not write ${target} in the sandbox: ${result.stderr.trim()}`);
    }
  };

  writeBinaryFile = ({ content, ...options }: WriteBinaryOptions): Promise<void> =>
    this.writeFile({
      ...options,
      content: new Blob([content as Uint8Array<ArrayBuffer>]).stream(),
    });

  writeTextFile = ({ content, encoding = 'utf-8', ...options }: WriteTextOptions): Promise<void> =>
    this.writeBinaryFile({
      ...options,
      content: new Uint8Array(Buffer.from(content, encoding as BufferEncoding)),
    });

  /** Stops every process this view still runs in the sandbox. */
  protected async killAll(): Promise<void> {
    await Promise.all([...this.handle.processes].map((pidFile) => this.killTree(pidFile)));
    this.handle.processes.clear();
  }

  private async killTree(pidFile: string): Promise<void> {
    await this.handle.cli.run([...this.execArgs({}), 'sh', '-c', KILL_TREE, pidFile]);
  }

  private resolve(path: string): string {
    return posix.resolve(this.handle.workingDirectory, path);
  }

  /**
   * `sbx exec` up to the sandbox name. Variables go as bare `-e NAME`: `sbx` then reads each value
   * from its own environment, so none of them ever shows on a command line.
   */
  protected execArgs({
    workingDirectory,
    env = {},
    stdin = false,
  }: {
    env?: Record<string, string>;
    stdin?: boolean;
    workingDirectory?: string;
  }): string[] {
    return [
      'exec',
      ...(stdin ? ['-i'] : []),
      '-w',
      this.resolve(workingDirectory ?? '.'),
      ...Object.keys(env).flatMap((name) => ['-e', name]),
      this.handle.name,
    ];
  }
}
