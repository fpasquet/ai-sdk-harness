import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';

import { createServer } from 'node:http';

import type { SandboxesOptions } from '../sandboxes/sandboxes.js';

import { HttpError } from '../../common/http-error.js';
import { fail, sameSecret, send } from '../../common/http-reply.js';
import { PACKAGE_VERSION } from '../../common/package-version.js';
import { PROTOCOL_HEADER, PROTOCOL_VERSION, SERVICE_TOKEN_HEADER } from '../../protocol/version.js';
import { Sandboxes } from '../sandboxes/sandboxes.js';
import { tunnel } from './port-tunnel.js';
import { ROUTES } from './routes.js';

/** What the service is made of: its sandboxes', and its own. */
export interface ServiceOptions extends SandboxesOptions {
  /**
   * A secret every call must carry in `x-ai-sdk-sandbox-token`, beside Cloud Run's IAM: a second
   * lock, should the service ever be deployed open by mistake.
   */
  serviceToken?: string;
}

/** The sandbox service: its HTTP server, and the sandboxes it drives. */
export interface SandboxServer {
  readonly server: Server;
  readonly sandboxes: Sandboxes;
  /** Stops listening. The sandboxes run on: their machines are not the service's to keep. */
  close(): Promise<void>;
}

/**
 * Why the service refuses `request` before any route sees it: a client speaking another protocol,
 * or a missing or wrong service token. `undefined` when it does not.
 */
export function refusal(
  request: IncomingMessage,
  serviceToken: string | undefined,
): HttpError | undefined {
  const protocol = request.headers[PROTOCOL_HEADER];
  if (protocol !== undefined && protocol !== String(PROTOCOL_VERSION)) {
    return new HttpError(
      400,
      `This client speaks protocol ${String(protocol)} of ai-sdk-sandbox-gce, this service ${PROTOCOL_VERSION} (version ${PACKAGE_VERSION}): deploy the service with the version of the package the application uses.`,
    );
  }
  if (
    serviceToken !== undefined &&
    !sameSecret(request.headers[SERVICE_TOKEN_HEADER], serviceToken)
  ) {
    return new HttpError(401, 'The service token is missing or wrong.');
  }
  return undefined;
}

async function handle(
  options: ServiceOptions & { sandboxes: Sandboxes },
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  response.setHeader(PROTOCOL_HEADER, String(PROTOCOL_VERSION));
  const path = new URL(request.url ?? '/', 'http://service').pathname;
  const refused = path === '/health' ? undefined : refusal(request, options.serviceToken);
  if (refused !== undefined) {
    send(response, { status: refused.status, body: { error: refused.message } });
    return;
  }
  const matching = ROUTES.filter((route) => route.path.test(path));
  const route = matching.find(({ method }) => method === request.method);
  if (route === undefined) {
    const status = matching.length > 0 ? 405 : 404;
    send(response, { status, body: { error: `No route for ${request.method} ${path}.` } });
    return;
  }
  const params = (route.path.exec(path) ?? []).slice(1).map((param) => decodeURIComponent(param));
  try {
    const reply = await route.handle({ sandboxes: options.sandboxes, params, request, response });
    if (reply !== undefined) send(response, reply);
  } catch (error) {
    fail(response, error, (message) =>
      options.logger.error(`${request.method} ${path} failed: ${message}`),
    );
  }
}

/**
 * The sandbox service, not yet listening: the HTTP API of `ai-sdk-sandbox-cloud-run`, over sandboxes
 * that are Compute Engine machines, so that an application can create a sandbox per session, run
 * commands and read and write files in it, reach a harness bridge in it, and keep its credentials
 * out of it.
 *
 * It has no authentication of its own: on Cloud Run, IAM only lets through the identities granted
 * `roles/run.invoker` on the service. Never expose it otherwise.
 */
export function createSandboxServer(options: ServiceOptions): SandboxServer {
  const sandboxes = new Sandboxes(options);
  const server = createServer((request, response) => {
    void handle({ ...options, sandboxes }, request, response);
  });
  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    void tunnel(sandboxes, request, {
      socket,
      head,
      refused: refusal(request, options.serviceToken),
    });
  });
  return {
    server,
    sandboxes,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
