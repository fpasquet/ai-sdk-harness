import type {
  Experimental_SandboxProcess as SandboxProcess,
  Experimental_SandboxSession as SandboxSession,
} from '@ai-sdk/provider-utils';

import { posix } from 'node:path';

import type {
  MicrosandboxConnection,
  SandboxExecution,
} from '../transport/microsandbox-connection.js';

import { READ, READ_DIRECTORY, READ_MISSING, WRITE } from '../transport/sandbox-scripts.js';
import { abortReason } from '../utils/abort.js';

type ProcessOptions = Parameters<SandboxSession['spawn']>[0];
type ReadOptions = Parameters<SandboxSession['readFile']>[0];
type ReadTextOptions = Parameters<SandboxSession['readTextFile']>[0];
type WriteOptions = Parameters<SandboxSession['writeFile']>[0];
type WriteBinaryOptions = Parameters<SandboxSession['writeBinaryFile']>[0];
type WriteTextOptions = Parameters<SandboxSession['writeTextFile']>[0];

/** What every view of one sandbox shares: its connection, its working directory, its processes. */
export interface MicrosandboxSandboxHandle {
  readonly connection: MicrosandboxConnection;
  /** The sandbox's own working directory, which relative paths resolve against. */
  readonly workingDirectory: string;
  /** The processes spawned and not yet exited. */
  readonly processes: Set<SandboxExecution>;
}

/**
 * The file and process surface of a microsandbox: what a harness hands to its tools. Every call is
 * a command run by the sandbox's agent, as the sandbox's user: nothing runs on the host, and only
 * the variables a command names are forwarded, never this process's environment.
 */
export class MicrosandboxSandboxSession implements SandboxSession {
  constructor(protected readonly handle: MicrosandboxSandboxHandle) {}

  get description(): string {
    return [
      `microsandbox "${this.handle.connection.name}": a microVM with a Linux kernel and a filesystem of its own, working directory ${this.handle.workingDirectory}.`,
      "Outbound traffic goes through microsandbox's network stack and its policy.",
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

  spawn = async ({
    command,
    workingDirectory,
    env = {},
    abortSignal,
  }: ProcessOptions): Promise<SandboxProcess> => {
    if (abortSignal?.aborted) throw abortReason(abortSignal);
    const running = await this.handle.connection.start(['sh', '-c', command], {
      cwd: this.resolve(workingDirectory ?? '.'),
      env,
    });
    this.handle.processes.add(running);

    const kill = (): Promise<void> => running.kill();
    const onAbort = (): void => void kill();
    abortSignal?.addEventListener('abort', onAbort, { once: true });
    // Aborted while the command was starting.
    if (abortSignal?.aborted) onAbort();

    const exited = running.wait().finally(() => {
      this.handle.processes.delete(running);
      abortSignal?.removeEventListener('abort', onAbort);
    });
    const waited = exited.then((result) => {
      if (abortSignal?.aborted) throw abortReason(abortSignal);
      return result;
    });
    // `wait()` may never be called; an unobserved rejection must not take the process down.
    waited.catch(() => undefined);

    return { stdout: running.stdout, stderr: running.stderr, wait: () => waited, kill };
  };

  readBinaryFile = async ({ path, abortSignal }: ReadOptions): Promise<null | Uint8Array> => {
    abortSignal?.throwIfAborted();
    const target = this.resolve(path);
    const result = await this.handle.connection.run(['sh', '-c', READ, target]);
    if (result.exitCode === READ_MISSING) return null;
    if (result.exitCode === READ_DIRECTORY) {
      throw Object.assign(new Error(`EISDIR: illegal operation on a directory, read '${target}'`), {
        code: 'EISDIR',
      });
    }
    if (result.exitCode !== 0) {
      throw new Error(`Could not read ${target} in the sandbox: ${result.stderr.trim()}`);
    }
    return result.stdout;
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
    abortSignal?.throwIfAborted();
    const target = this.resolve(path);
    const stdin = new Uint8Array(await new Response(content).arrayBuffer());
    const result = await this.handle.connection.run(['sh', '-c', WRITE, target], { stdin });
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

  /** Stops every process the views of this sandbox still run. */
  protected async killAll(): Promise<void> {
    await Promise.all([...this.handle.processes].map((running) => running.kill()));
    this.handle.processes.clear();
  }

  private resolve(path: string): string {
    return posix.resolve(this.handle.workingDirectory, path);
  }
}
