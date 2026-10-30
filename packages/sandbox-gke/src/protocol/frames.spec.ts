import { describe, expect, it } from 'vitest';

import {
  encodeData,
  encodeFrame,
  FrameDecoder,
  FrameType,
  HEADER_BYTES,
  MAX_PAYLOAD_BYTES,
  readFrames,
  STDOUT,
} from './frames.js';

describe('frames', () => {
  it('come back whole, whatever the chunks they arrive in', () => {
    const bytes = Buffer.concat([
      encodeFrame(FrameType.Open, 7),
      encodeFrame(FrameType.Data, 7, Buffer.from('hello')),
      encodeFrame(FrameType.Exit, 0, Buffer.from('3')),
    ]);
    const decoder = new FrameDecoder();

    const frames = [...bytes].flatMap((byte) => decoder.push(Uint8Array.of(byte)));

    expect(frames.map(({ type, channel, payload }) => [type, channel, payload.toString()])).toEqual(
      [
        [FrameType.Open, 7, ''],
        [FrameType.Data, 7, 'hello'],
        [FrameType.Exit, 0, '3'],
      ],
    );
  });

  it('split data larger than a frame holds', () => {
    const frames = encodeData(STDOUT, new Uint8Array(MAX_PAYLOAD_BYTES + 10));

    expect(frames.map((frame) => frame.length - HEADER_BYTES)).toEqual([MAX_PAYLOAD_BYTES, 10]);
  });

  it('refuse a frame announced larger than a frame may be', () => {
    const header = encodeFrame(FrameType.Data, 1);
    header.writeUInt32BE(MAX_PAYLOAD_BYTES + 1, 5);

    expect(() => new FrameDecoder().push(header)).toThrow('too large');
  });

  it('are read from a stream as they complete', async () => {
    const stream = new Blob([
      new Uint8Array(encodeFrame(FrameType.Data, STDOUT, Buffer.from('x'))),
    ]).stream();
    const frames = [];

    for await (const frame of readFrames(stream)) frames.push(frame);

    expect(frames).toHaveLength(1);
  });
});
