import type { IncomingMessage } from 'node:http';

import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { readCommandLine } from './command-line.js';

/** A request whose body is `chunks`, then its end. */
function requestOf(...chunks: (Buffer | string)[]): IncomingMessage {
  const stream = new PassThrough();
  for (const chunk of chunks) stream.write(chunk);
  stream.end();
  return stream as unknown as IncomingMessage;
}

describe('the command line of an exec request', () => {
  it('reads the command, and leaves its standard input after it', async () => {
    const { command, line, rest } = await readCommandLine(
      requestOf('{"command":"cat","workingDirectory":"/w",', '"env":{"A":"1"}}\nin', 'put'),
    );

    expect(command).toEqual({ command: 'cat', workingDirectory: '/w', env: { A: '1' } });
    expect(line.toString()).toBe('{"command":"cat","workingDirectory":"/w","env":{"A":"1"}}');
    expect(rest.toString()).toBe('in');
  });

  it('refuses a request without a command line', async () => {
    await expect(readCommandLine(requestOf('{"command":"cat"}'))).rejects.toMatchObject({
      status: 400,
      message: 'The request holds no command line.',
    });
  });

  it('refuses a command line that is not a command', async () => {
    await expect(readCommandLine(requestOf('not json\n'))).rejects.toMatchObject({ status: 400 });
    await expect(readCommandLine(requestOf('{"command":1}\n'))).rejects.toThrow(
      '`command` must be a string.',
    );
  });

  it('refuses a command line too large', async () => {
    const request = new PassThrough();
    const read = readCommandLine(request as unknown as IncomingMessage);
    request.write(Buffer.alloc((1 << 20) + 1, 'a'));

    await expect(read).rejects.toMatchObject({ status: 413 });
  });
});
