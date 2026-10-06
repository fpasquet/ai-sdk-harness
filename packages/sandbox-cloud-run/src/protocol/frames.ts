/**
 * The one binary framing of the package, on three byte streams:
 *
 * - the response of `POST /v1/sandboxes/:name/exec`, where `channel` is the stream a chunk came
 *   from ({@link STDOUT} or {@link STDERR}) and an {@link FrameType.Exit} frame ends the process;
 * - the standard input and output of the egress relay that runs in each sandbox, where `channel`
 *   is the connection a frame belongs to, so that every connection the sandbox opens goes through
 *   one `sandbox exec`.
 *
 * A frame is a 9-byte header, type (u8), channel (u32 BE) and payload length (u32 BE), then the
 * payload.
 */
export const FrameType = {
  /**
   * The sandbox opened a connection, no payload. On channel 0: the egress relay listens, on the
   * port its payload says. First in the answer to `exec`, on channel 0: the process started, its
   * id the payload.
   */
  Open: 1,
  /** Bytes of a stream or of a connection. */
  Data: 2,
  /** A connection is closed, by either end. No payload. */
  End: 3,
  /** The process exited: its exit code, as ASCII digits. */
  Exit: 4,
} as const;

export type FrameType = (typeof FrameType)[keyof typeof FrameType];

export interface Frame {
  type: FrameType;
  channel: number;
  payload: Buffer;
}

export const HEADER_BYTES = 9;
/** Larger payloads are split: a frame is buffered whole on its way in. */
export const MAX_PAYLOAD_BYTES = 1 << 20;

export const STDOUT = 1;
export const STDERR = 2;

export function encodeFrame(
  type: FrameType,
  channel: number,
  payload: Uint8Array = new Uint8Array(),
): Buffer {
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt8(type, 0);
  header.writeUInt32BE(channel, 1);
  header.writeUInt32BE(payload.byteLength, 5);
  return Buffer.concat([header, payload]);
}

/** {@link encodeFrame} for data, split into frames no larger than {@link MAX_PAYLOAD_BYTES}. */
export function encodeData(channel: number, data: Uint8Array): Buffer[] {
  const frames: Buffer[] = [];
  for (let offset = 0; offset < data.byteLength; offset += MAX_PAYLOAD_BYTES) {
    frames.push(
      encodeFrame(FrameType.Data, channel, data.subarray(offset, offset + MAX_PAYLOAD_BYTES)),
    );
  }
  return frames;
}

/** Reassembles the frames of a byte stream, whatever the chunks it comes in. */
export class FrameDecoder {
  private buffered = Buffer.alloc(0);

  /** The frames completed by `chunk`, in order. */
  push(chunk: Uint8Array): Frame[] {
    this.buffered = Buffer.concat([this.buffered, chunk]);
    const frames: Frame[] = [];
    while (this.buffered.length >= HEADER_BYTES) {
      const length = this.buffered.readUInt32BE(5);
      if (length > MAX_PAYLOAD_BYTES) throw new Error(`A frame of ${length} bytes is too large.`);
      if (this.buffered.length < HEADER_BYTES + length) break;
      frames.push({
        type: this.buffered.readUInt8(0) as FrameType,
        channel: this.buffered.readUInt32BE(1),
        payload: this.buffered.subarray(HEADER_BYTES, HEADER_BYTES + length),
      });
      this.buffered = this.buffered.subarray(HEADER_BYTES + length);
    }
    return frames;
  }
}

/** The frames of a byte stream, as they complete. */
export async function* readFrames(stream: AsyncIterable<Uint8Array>): AsyncGenerator<Frame> {
  const decoder = new FrameDecoder();
  for await (const chunk of stream) yield* decoder.push(chunk);
}
