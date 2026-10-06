import type {
  Experimental_SandboxProcess as SandboxProcess,
  Experimental_SandboxSession as SandboxSession,
} from '@ai-sdk/provider-utils';

import { posix } from 'node:path';

import type { SandboxServiceClient } from './sandbox-service-client.js';

import { FrameType, readFrames, STDERR, STDOUT } from './protocol/frames.js';

type ProcessOptions = Parameters<SandboxSession['spawn']>[0];
type ReadOptions = Parameters<SandboxSession['readFile']>[0];
type ReadTextOptions = Parameters<SandboxSession['readTextFile']>[0];
type WriteOptions = Parameters<SandboxSession['writeFile']>[0];
type WriteBinaryOptions = Parameters<SandboxSession['writeBinaryFile']>[0];
type WriteTextOptions = Parameters<SandboxSession['writeTextFile']>[0];
type Sink = Pick<ReadableStreamDefaultController<Uint8Array>, 'enqueue'>;

const READ_MISSING = 44;
const READ_DIRECTORY = 45;
/** `cat` the file `$0`, with exit statuses of its own for a missing path and for a directory. */
const READ = `[ -d "$0" ] && exit ${READ_DIRECTORY}; [ -e "$0" ] || exit ${READ_MISSING}; exec cat -- "$0"`;
/** Writes stdin to the file `$0`, creating its parent directories. */
const WRITE = 'mkdir -p "$(dirname "$0")" && cat > "$0"';

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Why `signal` was aborted, as an error to reject with. */
export const abortReason = (signal: AbortSignal): Error => {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new DOMException('Aborted', 'AbortError');
};

/** `sh -c BODY ARG`, the argument quoted, never spliced into the body. */
const script = (body: string, arg: string): string =>
  `sh -c '${body.replace(/'/g, `'\\''`)}' '${arg.replace(/'/g, `'\\''`)}'`;

/** A stream's controller, whose reader may have cancelled it: its output is then dropped. */
function tolerant(
  controller: ReadableStreamDefaultController<Uint8Array>,
): Sink & { close(): void } {
  return {
    enqueue: (chunk) => {
      try {
        controller.enqueue(chunk);
      } catch {
        // Cancelled: nobody reads it any more.
      }
    },
    close: () => {
      try {
        controller.close();
      } catch {
        // Cancelled: nothing to close.
      }
    },
  };
}

/** Hands the frames of `response` to `sinks`: the exit code, or `undefined` if it broke off first. */
async function readOutput(
  response: Response,
  sinks: Record<'stderr' | 'stdout', Sink>,
): Promise<number | undefined> {
  if (response.body === null) return undefined;
  for await (const { type, channel, payload } of readFrames(response.body)) {
    if (type === FrameType.Exit) return Number(payload.toString());
    if (type === FrameType.Data && channel === STDOUT) sinks.stdout.enqueue(payload);
    if (type === FrameType.Data && channel === STDERR) sinks.stderr.enqueue(payload);
  }
  return undefined;
}

/** What every view of one sandbox shares: its name, the service that runs it, its processes. */
export interface CloudRunSandboxHandle {
  readonly client: SandboxServiceClient;
  /** The sandbox's name on the service. */
  readonly name: string;
  /** The sandbox's working directory, which relative paths resolve against. */
  readonly workingDirectory: string;
  /** The ids of the processes this session started and that may still run. */
  readonly processes: Set<string>;
}

/**
 * The file and process surface of a Cloud Run sandbox: what a harness hands to its tools. Every
 * call is a command the sandbox service runs in the sandbox: files are read and written by `cat`,
 * their bytes carried in the request and in the response's frames.
 */
export class CloudRunSandboxSession implements SandboxSession {
  constructor(protected readonly handle: CloudRunSandboxHandle) {}

  get description(): string {
    return [
      `Cloud Run sandbox "${this.handle.name}": a sandbox with a filesystem of its own, working directory ${this.handle.workingDirectory}.`,
      'It has no network of its own: it reaches the allowed hosts through the sandbox service alone.',
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
    const invalid = Object.keys(env).find((name) => !ENV_NAME.test(name));
    if (invalid !== undefined) throw new Error(`Not an environment variable name: ${invalid}`);
    const { client, name, processes } = this.handle;
    const response = await client.exec(name, {
      command: { command, workingDirectory: this.resolve(workingDirectory ?? '.'), env },
    });
    const id = response.headers.get('x-process-id') ?? '';
    processes.add(id);
    return this.attach(response, id, abortSignal);
  };

  readBinaryFile = async ({ path, abortSignal }: ReadOptions): Promise<null | Uint8Array> => {
    const target = this.resolve(path);
    const { exitCode, stdout, stderr } = await this.exec(script(READ, target), { abortSignal });
    if (exitCode === READ_MISSING) return null;
    if (exitCode === READ_DIRECTORY) {
      throw Object.assign(new Error(`EISDIR: illegal operation on a directory, read '${target}'`), {
        code: 'EISDIR',
      });
    }
    if (exitCode !== 0)
      throw new Error(`Could not read ${target} in the sandbox: ${stderr.trim()}`);
    return stdout;
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

  writeBinaryFile = async ({ path, content, abortSignal }: WriteBinaryOptions): Promise<void> => {
    const target = this.resolve(path);
    const { exitCode, stderr } = await this.exec(script(WRITE, target), {
      abortSignal,
      stdin: content,
    });
    if (exitCode !== 0)
      throw new Error(`Could not write ${target} in the sandbox: ${stderr.trim()}`);
  };

  writeFile = async ({ content, ...options }: WriteOptions): Promise<void> =>
    this.writeBinaryFile({
      ...options,
      content: new Uint8Array(await new Response(content).arrayBuffer()),
    });

  writeTextFile = ({ content, encoding = 'utf-8', ...options }: WriteTextOptions): Promise<void> =>
    this.writeBinaryFile({
      ...options,
      content: new Uint8Array(Buffer.from(content, encoding as BufferEncoding)),
    });

  /** Stops every process this session started and that may still run. */
  protected async killAll(): Promise<void> {
    const { client, name, processes } = this.handle;
    await Promise.all([...processes].map((id) => client.kill(name, id)));
    processes.clear();
  }

  /** The process `id`, its output read from `response` as it comes. */
  private attach(response: Response, id: string, abortSignal?: AbortSignal): SandboxProcess {
    const { client, name, processes } = this.handle;
    let stdout!: ReadableStreamDefaultController<Uint8Array>;
    let stderr!: ReadableStreamDefaultController<Uint8Array>;
    const streams = {
      stdout: new ReadableStream<Uint8Array>({ start: (controller) => void (stdout = controller) }),
      stderr: new ReadableStream<Uint8Array>({ start: (controller) => void (stderr = controller) }),
    };
    const sinks = { stdout: tolerant(stdout), stderr: tolerant(stderr) };
    let killed: Promise<void> | undefined;
    const kill = (): Promise<void> => (killed ??= client.kill(name, id));
    const onAbort = (): void => void kill();
    abortSignal?.addEventListener('abort', onAbort, { once: true });
    const exited = this.follow(response, id, sinks).then(({ exitCode }) => {
      if (abortSignal?.aborted) throw abortReason(abortSignal);
      return { exitCode };
    });
    void exited
      .finally(() => {
        processes.delete(id);
        abortSignal?.removeEventListener('abort', onAbort);
        sinks.stdout.close();
        sinks.stderr.close();
      })
      // `wait()` may never be called; an unobserved rejection must not take the process down.
      .catch(() => undefined);
    return { ...streams, wait: () => exited, kill };
  }

  /** Runs a command to completion, its output kept as bytes. */
  private async exec(
    command: string,
    { abortSignal, stdin }: { abortSignal?: AbortSignal; stdin?: Uint8Array },
  ): Promise<{ exitCode: number; stderr: string; stdout: Uint8Array }> {
    if (abortSignal?.aborted) throw abortReason(abortSignal);
    const { client, name, workingDirectory } = this.handle;
    const response = await client.exec(
      name,
      { command: { command, workingDirectory }, stdin },
      abortSignal,
    );
    const stdout: Uint8Array[] = [];
    const stderr: Uint8Array[] = [];
    const { exitCode } = await this.follow(response, response.headers.get('x-process-id') ?? '', {
      stdout: { enqueue: (chunk) => stdout.push(chunk) },
      stderr: { enqueue: (chunk) => stderr.push(chunk) },
    });
    return {
      exitCode,
      stdout: new Uint8Array(Buffer.concat(stdout)),
      stderr: Buffer.concat(stderr).toString(),
    };
  }

  /**
   * Hands the output of a process to `sinks`, up to its exit code. Cloud Run cuts a response after
   * its timeout: the process runs on, and its exit is then waited for by id, its output lost.
   */
  private async follow(
    response: Response,
    id: string,
    sinks: Record<'stderr' | 'stdout', Sink>,
  ): Promise<{ exitCode: number }> {
    const streamed = await readOutput(response, sinks).catch(() => undefined);
    if (streamed !== undefined) return { exitCode: streamed };
    for (;;) {
      const exitCode = await this.handle.client.wait(this.handle.name, id).catch(() => 137);
      if (exitCode !== undefined) return { exitCode };
    }
  }

  private resolve(path: string): string {
    return posix.resolve(this.handle.workingDirectory, path);
  }
}
