import type {
  Experimental_SandboxProcess as SandboxProcess,
  Experimental_SandboxSession as SandboxSession,
} from '@ai-sdk/provider-utils';

import { posix } from 'node:path';

import type { Outcome } from '../../protocol/messages.js';
import type { LinkChannel } from '../transport/supervisor-link.js';
import type { SupervisorHost } from './supervisor-host.js';

import { abortReason } from '../utils/abort.js';

type ProcessOptions = Parameters<SandboxSession['spawn']>[0];
type ReadOptions = Parameters<SandboxSession['readFile']>[0];
type ReadTextOptions = Parameters<SandboxSession['readTextFile']>[0];
type WriteOptions = Parameters<SandboxSession['writeFile']>[0];
type WriteBinaryOptions = Parameters<SandboxSession['writeBinaryFile']>[0];
type WriteTextOptions = Parameters<SandboxSession['writeTextFile']>[0];

/** What every view of one sandbox shares, and the processes of the view. */
export interface SrtSandboxHandle {
  /** The sandbox's id, the name of its directory. */
  readonly id: string;
  readonly supervisor: SupervisorHost;
  /** The sandbox's working directory, which relative paths resolve against. */
  readonly workingDirectory: string;
  /** The processes this view started and that still run. */
  readonly processes: Set<LinkChannel>;
}

/** A stream fed as bytes come, closed when its channel is. */
function feed(): {
  close: () => void;
  push: (chunk: Buffer) => void;
  stream: ReadableStream<Uint8Array>;
} {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let open = true;
  const stream = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) });
  return {
    stream,
    push: (chunk) => open && controller.enqueue(new Uint8Array(chunk)),
    close: () => {
      if (open) controller.close();
      open = false;
    },
  };
}

/** The error an outcome stands for, with its Node.js code. */
function errorOf({ error }: { error: { code?: string; message: string } }): Error {
  return Object.assign(
    new Error(error.message),
    error.code === undefined ? {} : { code: error.code },
  );
}

/** `outcome`, which must be a success. */
function succeeded(outcome: Outcome): void {
  if ('error' in outcome) throw errorOf(outcome);
}

/**
 * The file and process surface of an srt sandbox: what a harness hands to its tools. Every call
 * goes through the sandbox's supervisor, inside srt: a process sees the sandbox's filesystem rules
 * and network, never more, and only the variables a command names are added to the sandbox's own
 * environment — never this process's.
 */
export class SrtSandboxSession implements SandboxSession {
  constructor(protected readonly handle: SrtSandboxHandle) {}

  get description(): string {
    return [
      `srt sandbox "${this.handle.id}": this host's filesystem behind srt's rules, working directory ${this.handle.workingDirectory}.`,
      'Outbound traffic goes through the srt proxy, which only lets the allowed hosts through.',
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
    const link = await this.handle.supervisor.link();
    const cwd = this.resolve(workingDirectory ?? '.');
    const channel = link.open({ kind: 'spawn', command, cwd, env });
    return this.processOf(channel, abortSignal);
  };

  readBinaryFile = async ({ path, abortSignal }: ReadOptions): Promise<null | Uint8Array> => {
    if (abortSignal?.aborted) throw abortReason(abortSignal);
    const channel = (await this.handle.supervisor.link()).open({
      kind: 'read',
      path: this.resolve(path),
    });
    const chunks: Buffer[] = [];
    channel.onData = (chunk) => chunks.push(chunk);
    const outcome = await channel.closed;
    if ('error' in outcome && outcome.error.code === 'ENOENT') return null;
    succeeded(outcome);
    return new Uint8Array(Buffer.concat(chunks));
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
    if (abortSignal?.aborted) throw abortReason(abortSignal);
    const channel = (await this.handle.supervisor.link()).open({
      kind: 'write',
      path: this.resolve(path),
    });
    for await (const chunk of content) channel.write(chunk);
    channel.end();
    succeeded(await channel.closed);
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
    const running = [...this.handle.processes];
    for (const channel of running) channel.kill();
    await Promise.all(running.map((channel) => channel.closed));
    this.handle.processes.clear();
  }

  private processOf(channel: LinkChannel, abortSignal?: AbortSignal): SandboxProcess {
    const stdout = feed();
    const stderr = feed();
    channel.onData = stdout.push;
    channel.onStderr = stderr.push;
    this.handle.processes.add(channel);
    const onAbort = (): void => channel.kill();
    abortSignal?.addEventListener('abort', onAbort, { once: true });
    const exited = channel.closed.then((outcome) => {
      this.handle.processes.delete(channel);
      abortSignal?.removeEventListener('abort', onAbort);
      stdout.close();
      stderr.close();
      if (abortSignal?.aborted) throw abortReason(abortSignal);
      if ('exitCode' in outcome) return { exitCode: outcome.exitCode };
      throw 'error' in outcome ? errorOf(outcome) : new Error('The process ended without a code.');
    });
    // `wait()` may never be called; an unobserved rejection must not take the process down.
    exited.catch(() => undefined);
    return {
      stdout: stdout.stream,
      stderr: stderr.stream,
      wait: () => exited,
      kill: async () => {
        channel.kill();
        await channel.closed;
      },
    };
  }

  private resolve(path: string): string {
    return posix.resolve(this.handle.workingDirectory, path);
  }
}
