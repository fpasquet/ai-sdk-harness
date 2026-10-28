import { describe, expect, it } from 'vitest';

import { MAX_INPUT_WRITE_BYTES } from '../../protocol/api.js';
import { processInput } from './process-input.js';

/** A service that takes its time: what it was sent, write by write, and whether it was ended. */
function slowService(): {
  ended: () => boolean;
  sender: Parameters<typeof processInput>[0];
  writes: { bytes: Uint8Array; offset: number }[];
} {
  const writes: { bytes: Uint8Array; offset: number }[] = [];
  let ended = false;
  return {
    writes,
    ended: () => ended,
    sender: {
      write: async (offset, bytes) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        writes.push({ offset, bytes });
      },
      end: () => {
        ended = true;
        return Promise.resolve();
      },
    },
  };
}

const text = (writes: { bytes: Uint8Array }[]): string =>
  writes.map(({ bytes }) => new TextDecoder().decode(bytes)).join('');

describe('the input of a remote process', () => {
  it('sends many small writes in order, in few requests, then ends', async () => {
    const service = slowService();
    const writer = processInput(service.sender).getWriter();

    for (let index = 0; index < 500; index++) await writer.write(new TextEncoder().encode('x'));
    await writer.close();

    expect(text(service.writes)).toBe('x'.repeat(500));
    expect(service.writes.length).toBeLessThan(5);
    expect(service.writes.map(({ offset }) => offset)).toEqual(
      service.writes.map((_, index) =>
        service.writes.slice(0, index).reduce((sum, { bytes }) => sum + bytes.byteLength, 0),
      ),
    );
    expect(service.ended()).toBe(true);
  });

  it('splits a large write into requests the service accepts', async () => {
    const service = slowService();
    const writer = processInput(service.sender).getWriter();

    await writer.write(new Uint8Array(MAX_INPUT_WRITE_BYTES * 2 + 1));
    await writer.close();

    expect(service.writes.map(({ offset, bytes }) => [offset, bytes.byteLength])).toEqual([
      [0, MAX_INPUT_WRITE_BYTES],
      [MAX_INPUT_WRITE_BYTES, MAX_INPUT_WRITE_BYTES],
      [MAX_INPUT_WRITE_BYTES * 2, 1],
    ]);
  });

  it('keeps the bytes of a write whose buffer is reused', async () => {
    const service = slowService();
    const writer = processInput(service.sender).getWriter();
    const buffer = new TextEncoder().encode('a');

    await writer.write(buffer);
    buffer[0] = 'b'.charCodeAt(0);
    await writer.write(buffer);
    await writer.close();

    expect(text(service.writes)).toBe('ab');
  });

  it('fails the next write and the close once a request fails, and ends nothing', async () => {
    let ended = false;
    const writer = processInput({
      write: () => Promise.reject(new Error('gone')),
      end: () => {
        ended = true;
        return Promise.resolve();
      },
    }).getWriter();

    await writer.write(new Uint8Array(1));
    await expect(writer.close()).rejects.toThrow('gone');
    expect(ended).toBe(false);
  });

  it('drops what did not leave on abort, and ends the input', async () => {
    const service = slowService();
    const writer = processInput(service.sender).getWriter();

    await writer.write(new TextEncoder().encode('a'));
    await writer.write(new TextEncoder().encode('b'));
    await writer.abort(new Error('stop'));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(text(service.writes)).toBe('a');
    expect(service.ended()).toBe(true);
  });
});
