import type { IncomingMessage, Server } from 'node:http';

import { createServer } from 'node:http';

import type { Logger } from '../common/logger.js';
import type { SandboxRegistry } from './registry.js';

import {
  readJson,
  requiredString,
  stringList,
  stringRecord,
  transformationList,
} from '../common/http-body.js';
import { HttpError } from '../common/http-error.js';
import { bearer, fail, NO_CONTENT, type Reply, sameSecret, send } from '../common/http-reply.js';
import { PACKAGE_VERSION } from '../common/package-version.js';
import { PROTOCOL_HEADER, PROTOCOL_VERSION } from '../protocol/version.js';

const SANDBOX = /^\/v1\/sandboxes\/([a-z0-9-]+)(\/[a-z]+)?$/;

type Json = Record<string, unknown>;

/** A request to one sandbox's route: its name, its body, and its query string. */
interface SandboxCall {
  name: string;
  body: Json;
  query: URLSearchParams;
}

/** `?serial=`, the registration a removal is meant for. */
function serialOf(query: URLSearchParams): number | undefined {
  const raw = query.get('serial');
  if (raw === null) return undefined;
  const serial = Number(raw);
  if (!Number.isSafeInteger(serial)) throw new HttpError(400, '`serial` must be an integer.');
  return serial;
}

/** What each route does to the registry. */
const ROUTES: Record<string, (registry: SandboxRegistry, call: SandboxCall) => Reply> = {
  'PUT ': (registry, { name, body }) => {
    registry.register(name, {
      address: requiredString(body, 'address'),
      allowedHosts: stringList(body, 'allowedHosts') ?? [],
      baseUrls: stringRecord(body, 'baseUrls') ?? {},
    });
    return NO_CONTENT;
  },
  'DELETE ': (registry, { name, query }) => {
    registry.remove(name, serialOf(query));
    return NO_CONTENT;
  },
  'PUT /network': (registry, { name, body }) => {
    registry.setAllowedHosts(name, stringList(body, 'allowedHosts') ?? []);
    return NO_CONTENT;
  },
  'POST /transformations': (registry, { name, body }) => {
    registry.addTransformations(name, transformationList(body));
    return NO_CONTENT;
  },
  'PUT /transformations': (registry, { name, body }) => {
    registry.setTransformations(name, transformationList(body));
    return NO_CONTENT;
  },
  'POST /screen': (registry, { name, body }) => ({
    status: 200,
    body: { refused: registry.holdsSecret(name, stringList(body, 'texts') ?? []) },
  }),
};

async function handle(
  registry: SandboxRegistry,
  request: IncomingMessage,
  url: URL,
): Promise<Reply> {
  const path = url.pathname;
  if (request.method === 'GET' && path === '/v1/sandboxes') {
    return { status: 200, body: { sandboxes: registry.list() } };
  }
  const [, name, action = ''] = SANDBOX.exec(path) ?? [];
  const route = ROUTES[`${request.method} ${action}`];
  if (name === undefined || route === undefined) {
    throw new HttpError(404, `No route for ${request.method} ${path}.`);
  }
  return route(registry, { name, body: await readJson(request), query: url.searchParams });
}

/**
 * The administration API of the egress proxy (`protocol/proxy.ts`): the sandbox service registers
 * the sandboxes there, with what they may reach and their credentials. Only the service may call
 * it: the VPC firewall lets nothing else reach its port, and every call carries the proxy's token.
 */
export function createAdminServer({
  registry,
  token,
  logger,
}: {
  registry: SandboxRegistry;
  token: string;
  logger: Logger;
}): Server {
  return createServer((request, response) => {
    response.setHeader(PROTOCOL_HEADER, String(PROTOCOL_VERSION));
    const method = request.method ?? 'GET';
    const url = new URL(request.url ?? '/', 'http://proxy');
    const path = url.pathname;
    if (path === '/health') {
      send(response, {
        status: 200,
        body: { status: 'ok', protocol: PROTOCOL_VERSION, version: PACKAGE_VERSION },
      });
      return;
    }
    const given = bearer(request.headers.authorization);
    if (given === undefined || !sameSecret(given, token)) {
      send(response, { status: 401, body: { error: 'The proxy token is missing or wrong.' } });
      return;
    }
    handle(registry, request, url).then(
      (reply) => send(response, reply),
      (error: unknown) =>
        fail(response, error, (message) => logger.error(`${method} ${path} failed: ${message}`)),
    );
  });
}
