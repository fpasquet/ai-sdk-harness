import type { AddressInfo, Socket } from 'node:net';

import { createServer } from 'node:net';

import { encodeData, encodeFrame, FrameDecoder, FrameType } from '../protocol/frames.js';

/**
 * Runs inside a sandbox, for as long as it lives: the sandbox's only way out. It listens on a port
 * of the sandbox's loopback (the sandbox's `HTTPS_PROXY` and base URLs) and carries every
 * connection made to it over its standard input and output, as frames, to the service's egress
 * proxy, which decides what may leave and adds the credentials.
 *
 * Usage: `node egress-relay.js <port>`, 0 for a free port.
 */
const port = Number(process.argv[2]);
const connections = new Map<number, Socket>();
let next = 1;

const send = (frame: Buffer): boolean => process.stdout.write(frame);

const server = createServer((socket) => {
  const channel = next++;
  connections.set(channel, socket);
  send(encodeFrame(FrameType.Open, channel));
  socket.on('data', (chunk: Buffer) => encodeData(channel, chunk).forEach(send));
  socket.once('close', () => {
    if (connections.delete(channel)) send(encodeFrame(FrameType.End, channel));
  });
  socket.on('error', () => socket.destroy());
});

const decoder = new FrameDecoder();
process.stdin.on('data', (chunk: Buffer) => {
  for (const { type, channel, payload } of decoder.push(chunk)) {
    const socket = connections.get(channel);
    if (type === FrameType.Data) socket?.write(payload);
    if (type === FrameType.End && socket !== undefined) {
      connections.delete(channel);
      socket.end();
    }
  }
});
// The service is gone: so is the way out.
process.stdin.once('end', () => process.exit(0));

server.once('error', (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
// Channel 0 opens once the relay listens, with the port it listens on: the service waits for it
// before handing the sandbox out.
server.listen(port, '127.0.0.1', () => {
  const { port: listening } = server.address() as AddressInfo;
  send(encodeFrame(FrameType.Open, 0, Buffer.from(String(listening))));
});
