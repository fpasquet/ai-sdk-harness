import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createServer } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Frame } from '../../protocol/frames.js';
import type { Sandboxes } from '../sandboxes/sandboxes.js';

import { fail } from '../../common/http-reply.js';
import { encodeFrame, FrameType, readFrames, STDOUT } from '../../protocol/frames.js';
import { AgentClient } from '../sandboxes/agent-client.js';
import { execRelay } from './exec-relay.js';

/** A server on a free port of the loopback, closed by `close`. */
async function listen(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ server: Server; port: number }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: (server.address() as AddressInfo).port };
}

const close = (server: Server): Promise<void> =>
  new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });

/** The frames of `response` as they came, and how its stream ended: `undefined` when it ended whole. */
async function framesOf(response: Response): Promise<{ frames: Frame[]; error?: unknown }> {
  const frames: Frame[] = [];
  try {
    for await (const frame of readFrames(response.body ?? new ReadableStream())) frames.push(frame);
    return { frames };
  } catch (error) {
    return { frames, error };
  }
}

describe('the relay of a command to the agent of its machine', () => {
  let agent: { server: Server; port: number };
  let relay: { server: Server; port: number };
  let answer: (request: IncomingMessage, response: ServerResponse) => void;

  beforeEach(async () => {
    agent = await listen((request, response) => answer(request, response));
    const sandboxes = {
      agent: () =>
        Promise.resolve(new AgentClient({ host: '127.0.0.1', port: agent.port, token: 't' })),
      assertNoSecret: () => Promise.resolve(),
    } as unknown as Sandboxes;
    // As the service handles a route that fails.
    relay = await listen((request, response) => {
      execRelay(sandboxes, 'box', { request, response }).catch((error: unknown) =>
        fail(response, error, () => undefined),
      );
    });
  });
  afterEach(async () => {
    await close(relay.server);
    await close(agent.server);
  });

  // Bounded: a relay that never ends its answer would otherwise hold the test to its timeout.
  const exec = (signal: AbortSignal = AbortSignal.timeout(5000)): Promise<Response> =>
    fetch(`http://127.0.0.1:${relay.port}/`, {
      method: 'POST',
      body: '{"command":"sleep 30"}\n',
      signal,
    });

  /** Answers as the agent does: its headers at once, the process's id, then its first output. */
  const started = (response: ServerResponse): void => {
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'x-process-id': 'p1' });
    response.write(encodeFrame(FrameType.Open, 0, Buffer.from('p1')));
    response.write(encodeFrame(FrameType.Data, STDOUT, Buffer.from('started\n')));
  };

  it('streams the agent’s frames back, up to the exit code', async () => {
    answer = (request, response) => {
      request.resume();
      started(response);
      response.end(encodeFrame(FrameType.Exit, 0, Buffer.from('0')));
    };

    const response = await exec();
    const { frames, error } = await framesOf(response);

    expect(response.headers.get('x-process-id')).toBe('p1');
    expect(error).toBeUndefined();
    expect(frames.map(({ type, payload }) => [type, payload.toString()])).toEqual([
      [FrameType.Open, 'p1'],
      [FrameType.Data, 'started\n'],
      [FrameType.Exit, '0'],
    ]);
  });

  it('answers with the agent’s error, its JSON or as it came', async () => {
    answer = (_, response) => response.writeHead(409).end('{"error":"Busy."}');
    const busy = await exec();
    expect([busy.status, await busy.json()]).toEqual([409, { error: 'Busy.' }]);

    answer = (_, response) => response.writeHead(503).end('down');
    const down = await exec();
    expect([down.status, await down.json()]).toEqual([503, { error: 'down' }]);
  });

  it('cuts its answer when the agent stops mid-command, its exit frame never coming', async () => {
    answer = (request, response) => {
      request.resume();
      started(response);
      // The agent restarted, or its machine stopping: its connection goes, the answer unfinished.
      setTimeout(() => response.socket?.destroy(), 50);
    };

    const { frames, error } = await framesOf(await exec());

    // Cut, not ended whole: the caller tells it from a command that exited, and waits by id.
    expect(error).toBeInstanceOf(TypeError);
    expect(frames.map(({ type }) => type)).toEqual([FrameType.Open, FrameType.Data]);
  });

  it('lets the agent’s stream go once the caller is gone, the process running on', async () => {
    let agentSide: ServerResponse | undefined;
    const released = new Promise<void>((resolve) => {
      answer = (request, response) => {
        request.resume();
        started(response);
        agentSide = response;
        response.once('close', resolve);
      };
    });
    const caller = new AbortController();

    const response = await exec(caller.signal);
    const reader = response.body?.getReader();
    await reader?.read();
    caller.abort();
    await released;

    expect(agentSide?.writableFinished).toBe(false);
  });
});
