import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

import { spawn } from 'node:child_process';

import type { Request } from '../../protocol/messages.js';

import { encodeJson, FrameDecoder, FrameType } from '../../protocol/frames.js';
import { SrtError } from '../errors/srt-error.js';
import { LinkChannel } from './link-channel.js';

export { LinkChannel } from './link-channel.js';

/** How long {@link SupervisorLink.stop} waits for the supervisor before killing it. */
const STOP_GRACE_MS = 5_000;
/** How much of the supervisor's own standard error is kept, to explain a failure. */
const STDERR_TAIL_BYTES = 4_096;

type SupervisorProcess = ChildProcessByStdio<Writable, Readable, Readable>;

/**
 * The supervisor of one sandbox, as this host sees it: the srt process that wraps it, and the
 * channels multiplexed on its standard input and output.
 */
export class SupervisorLink {
  /** Settles when the supervisor is gone, whatever the reason. */
  readonly exited: Promise<void>;

  private readonly channels = new Map<number, LinkChannel>();
  private nextChannel = 1;
  private alive = true;
  private stderrTail = '';

  private constructor(private readonly child: SupervisorProcess) {
    this.exited = new Promise((resolve) => {
      child.once('close', () => {
        this.alive = false;
        for (const channel of this.channels.values()) channel.abandon(this.goneMessage());
        this.channels.clear();
        resolve();
      });
    });
    child.stdin.on('error', () => undefined);
    child.stderr.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-STDERR_TAIL_BYTES);
    });
  }

  /**
   * Starts `argv` — srt wrapping the supervisor — with nothing of this process's environment but
   * `env`, and waits until the supervisor says it is up.
   */
  static start(argv: readonly string[], env: Record<string, string>): Promise<SupervisorLink> {
    const [command = '/bin/sh', ...args] = argv;
    const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const link = new SupervisorLink(child);
    return new Promise((resolve, reject) => {
      child.once('error', (error) =>
        reject(new SrtError(`Could not start the sandbox: ${error.message}`)),
      );
      void link.exited.then(() => reject(new SrtError(link.goneMessage())));
      link.listen(() => resolve(link));
    });
  }

  get running(): boolean {
    return this.alive;
  }

  /** Opens a channel for `request`. On a supervisor already gone, it closes at once, in error. */
  open(request: Request): LinkChannel {
    const channel = new LinkChannel(this.nextChannel++, (frame) => this.send(frame));
    if (!this.alive) {
      channel.abandon(this.goneMessage());
      return channel;
    }
    this.channels.set(channel.id, channel);
    void channel.closed.then(() => this.channels.delete(channel.id));
    this.send(encodeJson(FrameType.Open, channel.id, request));
    return channel;
  }

  /** Ends the supervisor, which stops every process of the sandbox. Idempotent. */
  async stop(): Promise<void> {
    if (!this.alive) return;
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill('SIGKILL'), STOP_GRACE_MS);
    await this.exited;
    clearTimeout(timer);
  }

  private send(frame: Buffer): void {
    if (this.alive) this.child.stdin.write(frame);
  }

  private listen(onReady: () => void): void {
    const decoder = new FrameDecoder();
    this.child.stdout.on('data', (chunk: Buffer) => {
      for (const frame of decoder.push(chunk)) {
        if (frame.type === FrameType.Ready) onReady();
        else this.channels.get(frame.channel)?.receive(frame);
      }
    });
  }

  private goneMessage(): string {
    const detail = this.stderrTail.trim();
    return detail === '' ? 'The sandbox stopped.' : `The sandbox stopped: ${detail}`;
  }
}
