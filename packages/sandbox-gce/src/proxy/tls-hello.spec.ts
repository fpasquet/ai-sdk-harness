import type { AddressInfo } from 'node:net';

import { createServer } from 'node:net';
import { connect } from 'node:tls';
import { describe, expect, it } from 'vitest';

import { readClientHello } from './tls-hello.js';

/** The first bytes Node.js's TLS client sends, a ClientHello naming `servername` if given. */
async function helloOf(servername?: string): Promise<Buffer> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const first = new Promise<Buffer>((resolve) =>
    server.once('connection', (socket) => socket.once('data', resolve)),
  );
  const client = connect({ host: '127.0.0.1', port, servername: servername ?? '' });
  client.on('error', () => undefined);
  const bytes = await first;
  client.destroy();
  server.close();
  return bytes;
}

/** `hello` split into two TLS records, as a client may send it. */
function inTwoRecords(hello: Buffer): Buffer {
  const handshake = hello.subarray(5);
  const record = (fragment: Buffer): Buffer =>
    Buffer.concat([
      Buffer.from([22, 3, 1, fragment.length >> 8, fragment.length & 0xff]),
      fragment,
    ]);
  const half = Math.floor(handshake.length / 2);
  return Buffer.concat([record(handshake.subarray(0, half)), record(handshake.subarray(half))]);
}

describe('readClientHello', () => {
  it('reads the server a ClientHello names', async () => {
    expect(readClientHello(await helloOf('registry.npmjs.org'))).toEqual({
      kind: 'hello',
      serverName: 'registry.npmjs.org',
    });
  });

  it('reads a ClientHello that names no server', async () => {
    expect(readClientHello(await helloOf())).toEqual({ kind: 'hello' });
  });

  it('reads a ClientHello spread over several records', async () => {
    const hello = inTwoRecords(await helloOf('example.com'));

    expect(readClientHello(hello)).toEqual({ kind: 'hello', serverName: 'example.com' });
  });

  it('asks for more bytes until the ClientHello is whole', async () => {
    const hello = await helloOf('example.com');

    expect(readClientHello(Buffer.alloc(0))).toEqual({ kind: 'incomplete' });
    expect(readClientHello(hello.subarray(0, 3))).toEqual({ kind: 'incomplete' });
    expect(readClientHello(hello.subarray(0, hello.length - 1))).toEqual({ kind: 'incomplete' });
  });

  it('tells apart what is no ClientHello', () => {
    expect(readClientHello(Buffer.from('GET / HTTP/1.1\r\n\r\n'))).toEqual({ kind: 'invalid' });
    expect(readClientHello(Buffer.from([22, 3, 1, 0, 4, 2, 0, 0, 0]))).toEqual({
      kind: 'invalid',
    });
    // A ClientHello whose extensions run past its end.
    expect(readClientHello(Buffer.from([22, 3, 1, 0, 8, 1, 0, 0, 4, 3, 3, 0, 0]))).toEqual({
      kind: 'invalid',
    });
  });
});
