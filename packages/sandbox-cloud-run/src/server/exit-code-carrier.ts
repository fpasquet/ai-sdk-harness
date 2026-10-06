import type { TransformCallback } from 'node:stream';

import { randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';

/** The shell a command runs under: it always succeeds, and reports the command's code last. */
const WRAPPER = '"$@"; code=$?; printf \'\\n%s%d\\n\' "$0" "$code" >&2; exit 0';

/**
 * The `sandbox` CLI of Cloud Run does not hand back the exit code of what it runs: any failure
 * comes out as 137. So each command runs under a shell that always succeeds and writes the
 * command's real code last on its standard error, after a marker of its own, which this stream
 * takes back out: the bytes before it are passed on untouched.
 */
export class ExitCodeCarrier extends Transform {
  /** The code the command reported, once its standard error is over. */
  exitCode?: number;
  readonly marker = `__ai_sdk_sandbox_exit_${randomUUID()}__=`;
  private held = Buffer.alloc(0);

  /** `argv`, under the shell that reports its code. */
  command(argv: readonly string[]): string[] {
    return ['/bin/sh', '-c', WRAPPER, this.marker, ...argv];
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    this.held = Buffer.concat([this.held, chunk]);
    // The marker comes last: everything but what could be its beginning goes on at once.
    const keep = Math.min(this.held.length, this.marker.length + 16);
    if (this.held.length > keep) this.push(this.held.subarray(0, this.held.length - keep));
    this.held = this.held.subarray(this.held.length - keep);
    done();
  }

  override _flush(done: TransformCallback): void {
    const tail = this.held.toString('latin1');
    const at = tail.lastIndexOf(`\n${this.marker}`);
    if (at === -1) {
      this.push(this.held);
    } else {
      this.exitCode = Number.parseInt(tail.slice(at + 1 + this.marker.length), 10);
      this.push(this.held.subarray(0, at));
    }
    done();
  }
}
