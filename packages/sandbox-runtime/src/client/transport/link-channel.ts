import type { Frame } from '../../protocol/frames.js';
import type { Outcome } from '../../protocol/messages.js';

import { encodeData, encodeFrame, FrameType } from '../../protocol/frames.js';

/** One exchange with the supervisor: a process, a connection, a file read or written. */
export class LinkChannel {
  /** Bytes: a process's standard output, a file's content, a connection's. */
  onData?: (chunk: Buffer) => void;
  /** No more bytes from the sandbox's side of a connection. */
  onEnd?: () => void;
  /** Bytes of a process's standard error. */
  onStderr?: (chunk: Buffer) => void;
  /** The outcome of the exchange, once the supervisor is done with it. */
  readonly closed: Promise<Outcome>;

  private settle!: (outcome: Outcome) => void;

  constructor(
    readonly id: number,
    private readonly send: (frame: Buffer) => void,
  ) {
    this.closed = new Promise((resolve) => (this.settle = resolve));
  }

  write(chunk: Uint8Array): void {
    for (const frame of encodeData(this.id, chunk)) this.send(frame);
  }

  end(): void {
    this.send(encodeFrame(FrameType.End, this.id));
  }

  kill(): void {
    this.send(encodeFrame(FrameType.Kill, this.id));
  }

  /** @internal */
  receive({ type, payload }: Frame): void {
    if (type === FrameType.Data) this.onData?.(payload);
    if (type === FrameType.Stderr) this.onStderr?.(payload);
    if (type === FrameType.End) this.onEnd?.();
    if (type === FrameType.Close) this.settle(JSON.parse(payload.toString()) as Outcome);
  }

  /** @internal The supervisor is gone: nothing more comes on this channel. */
  abandon(message: string): void {
    this.settle({ error: { message } });
  }
}
