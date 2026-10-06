import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';

import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

import type { Reply } from './routes.js';
import type { SandboxesOptions } from './sandboxes.js';

import { PROTOCOL_HEADER, PROTOCOL_VERSION, SERVICE_TOKEN_HEADER } from '../protocol/version.js';
import { HttpError } from './http-error.js';
import { PACKAGE_VERSION } from './package-version.js';
import { tunnel } from './port-tunnel.js';
import { ROUTES } from './routes.js';
import { Sandboxes } from './sandboxes.js';

/** What the service is made of: its sandboxes', and its own. */
export interface ServiceOptions extends SandboxesOptions {
  /**
   * A secret every call must carry in `x-ai-sdk-sandbox-token`, beside Cloud Run's IAM: a second
   * lock, should the service ever be deployed open by mistake.
   */
  serviceToken?: string;
}

/** The sandbox service: its HTTP server, and the sandboxes it runs. */
export interface SandboxServer {
  readonly server: Server;
  readonly sandboxes: Sandboxes;
  /** Saves every running sandbox to its snapshot, then stops listening. */
  close(): Promise<void>;
}

function send(response: ServerResponse, { status, body }: Reply): void {
  if (body === undefined) {
    response.writeHead(status).end();
    return;
  }
  response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
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
      `This client speaks protocol ${String(protocol)} of ai-sdk-sandbox-cloud-run, this service ${PROTOCOL_VERSION} (version ${PACKAGE_VERSION}): deploy the service with the version of the package the application uses.`,
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

/** Compares a secret in constant time: how long it takes says nothing of the expected one. */
function sameSecret(given: string | string[] | undefined, expected: string): boolean {
  if (typeof given !== 'string') return false;
  const digest = (value: string): Buffer => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(given), digest(expected));
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

/** Answers with the error's own status, or 500 for an error the service did not expect. */
function fail(response: ServerResponse, error: unknown, report: (message: string) => void): void {
  const known = error instanceof HttpError;
  const message = error instanceof Error ? error.message : String(error);
  if (!known) report(message);
  if (response.headersSent) response.destroy();
  else send(response, { status: known ? error.status : 500, body: { error: message } });
}

/**
 * The sandbox service, not yet listening: an HTTP API over the sandboxes of a Cloud Run instance,
 * so that an application running elsewhere can create a sandbox per session, run commands and read
 * and write files in it, reach a harness bridge in it, and keep its credentials out of it.
 *
 * It has no authentication of its own: on Cloud Run, IAM only lets through the identities granted
 * `roles/run.invoker` on the service. Never expose it otherwise.
 */
export function createSandboxServer(options: ServiceOptions): SandboxServer {
  const sandboxes = new Sandboxes(options);
  const server = createServer((request, response) => {
    void handle({ ...options, sandboxes }, request, response);
  });
  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) =>
    tunnel(sandboxes, request, { socket, head, refused: refusal(request, options.serviceToken) }),
  );
  return {
    server,
    sandboxes,
    close: async () => {
      await sandboxes.suspendAll();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
