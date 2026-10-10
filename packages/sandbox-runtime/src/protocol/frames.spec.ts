import { describe, expect, it } from 'vitest';

import {
  encodeData,
  encodeFrame,
  encodeJson,
  FrameDecoder,
  FrameType,
  HEADER_BYTES,
  MAX_PAYLOAD_BYTES,
} from './frames.js';

describe('frames', () => {
  it('decodes what it encodes, whatever the chunks it comes in', () => {
    const bytes = Buffer.concat([
      encodeJson(FrameType.Open, 1, { kind: 'read', path: '/a' }),
      encodeFrame(FrameType.End, 2),
    ]);
    const decoder = new FrameDecoder();

    const frames = [...bytes].flatMap((byte) => decoder.push(Uint8Array.of(byte)));

    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({ type: FrameType.Open, channel: 1 });
    expect(JSON.parse(frames[0]?.payload.toString() ?? '')).toEqual({ kind: 'read', path: '/a' });
    expect(frames[1]).toMatchObject({ type: FrameType.End, channel: 2, payload: Buffer.alloc(0) });
  });

  it('splits large data into frames a decoder accepts', () => {
    const data = new Uint8Array(MAX_PAYLOAD_BYTES + 10);

    const frames = encodeData(3, data, FrameType.Stderr);

    expect(frames.map((frame) => frame.length - HEADER_BYTES)).toEqual([MAX_PAYLOAD_BYTES, 10]);
    expect(new FrameDecoder().push(Buffer.concat(frames)).map(({ type }) => type)).toEqual([
      FrameType.Stderr,
      FrameType.Stderr,
    ]);
  });

  it('refuses a frame larger than the limit', () => {
    const header = Buffer.alloc(HEADER_BYTES);
    header.writeUInt32BE(MAX_PAYLOAD_BYTES + 1, 5);

    expect(() => new FrameDecoder().push(header)).toThrow('too large');
  });
});
