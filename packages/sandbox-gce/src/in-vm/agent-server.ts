import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';

import { createServer } from 'node:http';

import type { AgentSettings } from './agent.js';
import type { Processes } from './processes.js';

import { fail, sameSecret, send } from '../common/http-reply.js';
import { PACKAGE_VERSION } from '../common/package-version.js';
import { AGENT_TOKEN_HEADER } from '../protocol/agent.js';
import { PROTOCOL_HEADER, PROTOCOL_VERSION } from '../protocol/version.js';
import { Agent } from './agent.js';
import { forwardPort } from './port-forward.js';

/** The agent: its HTTP server, and the processes it runs. */
export interface AgentServer {
  readonly server: Server;
  readonly processes: Processes;
  close(): Promise<void>;
}

/**
 * The agent of a sandbox's machine (`ai-sdk-sandbox-gce agent`), not yet listening: the HTTP API
 * through which the sandbox service runs commands in the machine and reaches its ports. It runs as
 * root; the commands run as the sandbox's user, with nothing of the agent's environment.
 *
 * Only the service may call it: the VPC firewall lets nothing else reach its port, and every call
 * but the health check carries the token the service derived for this machine.
 */
export function createAgentServer(settings: AgentSettings): AgentServer {
  const agent = new Agent(settings);
  const trusted = (request: IncomingMessage): boolean =>
    sameSecret(request.headers[AGENT_TOKEN_HEADER], settings.token);

  const server = createServer((request, response) => {
    response.setHeader(PROTOCOL_HEADER, String(PROTOCOL_VERSION));
    const path = new URL(request.url ?? '/', 'http://agent').pathname;
    if (path === '/health') {
      send(response, {
        status: 200,
        body: { status: 'ok', protocol: PROTOCOL_VERSION, version: PACKAGE_VERSION },
      });
      return;
    }
    if (!trusted(request)) {
      send(response, { status: 401, body: { error: 'The agent token is missing or wrong.' } });
      return;
    }
    agent.handle(request, response, path).then(
      (reply) => {
        if (reply !== undefined) send(response, reply);
      },
      (error: unknown) =>
        fail(response, error, (message) =>
          settings.logger.error(`${request.method} ${path} failed: ${message}`),
        ),
    );
  });

  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => socket.destroy());
    if (trusted(request)) forwardPort(request, socket, head);
    else socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });

  return {
    server,
    processes: agent.processes,
    close: async () => {
      await agent.processes.killAll();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
