import type { Writable } from 'node:stream';

import { HttpError } from '../common/http-error.js';

/**
 * The standard input of a process started with `stdin`, written by requests of their own. Each
 * names the offset of its first byte in the input: a request sent again after an error writes
 * nothing twice, and one that would leave a gap is refused.
 */
export class ProcessInput {
  /** How many bytes of its input the process was given. */
  private received = 0;
  private ended = false;

  constructor(private readonly stdin: Writable) {}

  /** Gives the process what it was not given yet of `bytes`, the input from `offset` on. */
  async write(offset: number, bytes: Buffer): Promise<void> {
    if (offset > this.received) {
      throw new HttpError(
        409,
        `The input of the process is at byte ${this.received}, not ${offset}: a write is missing.`,
      );
    }
    const unseen = bytes.subarray(this.received - offset);
    if (unseen.length === 0) return;
    if (this.ended) throw new HttpError(409, 'The standard input of the process is closed.');
    // Counted at once: a request sent again meanwhile finds these bytes given already.
    this.received += unseen.length;
    await new Promise<void>((resolve, reject) => {
      this.stdin.write(unseen, (error) => {
        if (error === null || error === undefined) resolve();
        else reject(new HttpError(409, `The process no longer reads its input: ${error.message}`));
      });
    });
  }

  /** Ends the input, as many times as it is asked to. */
  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.stdin.end();
  }
}
