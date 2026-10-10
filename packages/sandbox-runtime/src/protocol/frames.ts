/**
 * The binary framing between this host and the supervisor that runs in each sandbox, on the
 * supervisor's standard input (host → sandbox) and output (sandbox → host). Every exchange is a
 * channel the host opens: a process, a connection to a port of the sandbox, the reading or the
 * writing of a file.
 *
 * A frame is a 9-byte header, type (u8), channel (u32 BE) and payload length (u32 BE), then the
 * payload.
 */
export const FrameType = {
  /** Host → sandbox: opens `channel` for the request its payload holds, as JSON. */
  Open: 1,
  /** Bytes: a file's content, a connection's, or a process's standard output. */
  Data: 2,
  /** Sandbox → host: bytes of a process's standard error. */
  Stderr: 3,
  /** No more bytes on this side of a connection, or of the file being written. No payload. */
  End: 4,
  /** Sandbox → host: the channel is done, with its outcome as JSON. Nothing follows on it. */
  Close: 5,
  /** Host → sandbox: stop what the channel runs, a process tree or a connection. No payload. */
  Kill: 6,
  /** Sandbox → host, on channel 0: the supervisor is up. Its payload is its pid, as JSON. */
  Ready: 7,
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

/** {@link encodeFrame} with a JSON payload. */
export function encodeJson(type: FrameType, channel: number, value: unknown): Buffer {
  return encodeFrame(type, channel, Buffer.from(JSON.stringify(value)));
}

/** {@link encodeFrame} for bytes, split into frames no larger than {@link MAX_PAYLOAD_BYTES}. */
export function encodeData(
  channel: number,
  data: Uint8Array,
  type: FrameType = FrameType.Data,
): Buffer[] {
  const frames: Buffer[] = [];
  for (let offset = 0; offset < data.byteLength; offset += MAX_PAYLOAD_BYTES) {
    frames.push(encodeFrame(type, channel, data.subarray(offset, offset + MAX_PAYLOAD_BYTES)));
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
