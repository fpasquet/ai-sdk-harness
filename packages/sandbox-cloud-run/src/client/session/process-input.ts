import { MAX_INPUT_WRITE_BYTES } from '../../protocol/api.js';

/** How the input of a process reaches the service: a write names where its bytes start. */
export interface InputSender {
  write(offset: number, bytes: Uint8Array): Promise<void>;
  end(): Promise<void>;
}

/** How many bytes may wait for their request before a write waits for them to leave. */
const MAX_WAITING_BYTES = 2 * MAX_INPUT_WRITE_BYTES;

/**
 * Sends what is written, in order, one request at a time. What is written while a request is on
 * its way waits, then leaves with the next one: many small writes cost few requests.
 */
class InputQueue {
  private readonly waiting: Uint8Array[] = [];
  private waitingBytes = 0;
  /** How many bytes the service was given: where the next request starts. */
  private sent = 0;
  private sending?: Promise<void>;
  private failure?: { error: unknown };

  constructor(private readonly send: InputSender['write']) {}

  get full(): boolean {
    return this.waitingBytes > MAX_WAITING_BYTES;
  }

  push(chunk: Uint8Array): void {
    this.throwIfFailed();
    if (chunk.byteLength === 0) return;
    // A copy: the writer may reuse its buffer once the write resolves, before the bytes leave.
    this.waiting.push(chunk.slice());
    this.waitingBytes += chunk.byteLength;
    this.sending ??= this.sendAll();
  }

  /** Drops what did not leave yet. */
  clear(): void {
    this.waiting.length = 0;
    this.waitingBytes = 0;
  }

  /** Resolves once every byte written has left, or throws why one could not. */
  async drained(): Promise<void> {
    while (this.sending !== undefined) await this.sending;
    this.throwIfFailed();
  }

  private throwIfFailed(): void {
    if (this.failure !== undefined) throw this.failure.error;
  }

  private async sendAll(): Promise<void> {
    try {
      while (this.waiting.length > 0) {
        const bytes = this.take();
        await this.send(this.sent, bytes);
        this.sent += bytes.byteLength;
      }
    } catch (error) {
      this.failure = { error };
      this.clear();
    } finally {
      this.sending = undefined;
    }
  }

  /** The bytes waiting, up to what one request carries. */
  private take(): Uint8Array {
    const size = Math.min(this.waitingBytes, MAX_INPUT_WRITE_BYTES);
    const bytes = new Uint8Array(size);
    let filled = 0;
    while (filled < size) {
      const chunk = this.waiting[0] ?? new Uint8Array();
      const part = chunk.subarray(0, size - filled);
      bytes.set(part, filled);
      filled += part.byteLength;
      if (part.byteLength === chunk.byteLength) this.waiting.shift();
      else this.waiting[0] = chunk.subarray(part.byteLength);
    }
    this.waitingBytes -= size;
    return bytes;
  }
}

/**
 * The standard input of a process started with `stdin`, written through the service. A write
 * resolves once its bytes are queued, and throws if an earlier one could not be sent; closing
 * waits for every byte to leave, then ends the input.
 */
export function processInput(sender: InputSender): WritableStream<Uint8Array> {
  const queue = new InputQueue((offset, bytes) => sender.write(offset, bytes));
  return new WritableStream<Uint8Array>({
    write: async (chunk) => {
      queue.push(chunk);
      if (queue.full) await queue.drained();
    },
    close: async () => {
      await queue.drained();
      await sender.end();
    },
    // What did not leave yet is dropped: the process reads the end of its input.
    abort: async () => {
      queue.clear();
      await sender.end().catch(() => undefined);
    },
  });
}
