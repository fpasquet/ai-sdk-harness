import type { Socket } from 'node:net';

import { connect } from 'node:net';

import type { RuntimeProcess } from '../runtime/sandbox-cli.js';

import { encodeData, encodeFrame, FrameDecoder, FrameType } from '../../protocol/frames.js';

/**
 * The service's end of a sandbox's egress relay: every connection the relay announces is opened to
 * the sandbox's egress proxy, on the service's loopback, and its bytes carried both ways as frames
 * over the relay's standard streams.
 */
export class EgressLink {
  /** Resolves with the port the relay listens on in the sandbox, once it does. */
  readonly listening: Promise<number>;
  private readonly sockets = new Map<number, Socket>();

  constructor(
    private readonly relay: RuntimeProcess,
    private readonly proxyPort: number,
  ) {
    let listening!: (port: number) => void;
    this.listening = new Promise<number>((resolve, reject) => {
      listening = resolve;
      void relay.exited.then(() => reject(new Error('The egress relay exited.')));
    });
    this.listening.catch(() => undefined);
    const decoder = new FrameDecoder();
    relay.stdout.on('data', (chunk: Buffer) => {
      for (const { type, channel, payload } of decoder.push(chunk)) {
        if (type === FrameType.Open && channel === 0) listening(Number(payload.toString()));
        else if (type === FrameType.Open) this.sockets.set(channel, this.open(channel));
        else if (type === FrameType.Data) this.sockets.get(channel)?.write(payload);
        else if (type === FrameType.End) this.sockets.get(channel)?.end();
      }
    });
    relay.stderr.resume();
    void relay.exited.then(() => {
      for (const socket of this.sockets.values()) socket.destroy();
    });
  }

  /** A connection of the sandbox, to its egress proxy. */
  private open(channel: number): Socket {
    const socket = connect({ port: this.proxyPort, host: '127.0.0.1' });
    socket.on('data', (chunk: Buffer) =>
      encodeData(channel, chunk).forEach((frame) => this.relay.stdin.write(frame)),
    );
    socket.on('error', () => socket.destroy());
    socket.once('close', () => {
      if (this.sockets.delete(channel)) this.relay.stdin.write(encodeFrame(FrameType.End, channel));
    });
    return socket;
  }
}
