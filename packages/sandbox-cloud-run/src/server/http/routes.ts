import type { IncomingMessage, ServerResponse } from 'node:http';

import type { Sandboxes } from '../sandboxes/sandboxes.js';

import { PROTOCOL_VERSION } from '../../protocol/version.js';
import { PACKAGE_VERSION } from '../package-version.js';
import { execStream } from './exec-stream.js';
import {
  optionalString,
  readJson,
  requiredString,
  stringList,
  stringRecord,
  transformationList,
} from './request-body.js';

/** What a route answers with: JSON, or nothing (204). */
export interface Reply {
  status: number;
  body?: unknown;
}

interface Context {
  sandboxes: Sandboxes;
  /** The route's captures: the sandbox's name first, then the rest. */
  params: string[];
  request: IncomingMessage;
  response: ServerResponse;
}

/** A route handles its request, or streams its own answer and replies with nothing. */
type Handler = (context: Context) => Promise<Reply | undefined>;

export interface Route {
  method: string;
  path: RegExp;
  handle: Handler;
}

/** How long `GET …/processes/:id` waits for an exit: less than any request timeout of Cloud Run. */
const WAIT_MS = 5 * 60_000;

const NO_CONTENT: Reply = { status: 204 };

const network = async (request: IncomingMessage) => {
  const body = await readJson(request);
  return {
    allowedHosts: stringList(body, 'allowedHosts'),
    baseUrls: stringRecord(body, 'baseUrls'),
    template: optionalString(body, 'template'),
    name: optionalString(body, 'name'),
  };
};

/** Waits for a process to exit, a few minutes at most: its exit code, or that it still runs. */
async function waitFor(exited: Promise<number>): Promise<Reply> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(resolve, WAIT_MS, undefined);
  });
  const exitCode = await Promise.race([exited, timeout]);
  clearTimeout(timer);
  return { status: 200, body: exitCode === undefined ? { running: true } : { exitCode } };
}

const SANDBOX = '/v1/sandboxes/([^/]+)';

const route = (method: string, path: RegExp, handle: Handler): Route => ({ method, path, handle });

/**
 * The service's API, version 1. Every route but the health check sits under `/v1`; a sandbox's
 * ports are reached by the tunnel (`port-tunnel.ts`), outside these routes.
 */
export const ROUTES: Route[] = [
  route('GET', /^\/health$/, () =>
    Promise.resolve({
      status: 200,
      body: { status: 'ok', protocol: PROTOCOL_VERSION, version: PACKAGE_VERSION },
    }),
  ),
  route('POST', /^\/v1\/sandboxes$/, async ({ sandboxes, request }) => {
    const { name, ...options } = await network(request);
    const sandbox = await sandboxes.create(name ?? '', options);
    return { status: 201, body: sandbox.describe() };
  }),
  route(
    'POST',
    new RegExp(`^${SANDBOX}/resume$`),
    async ({ sandboxes, params: [name = ''], request }) => {
      const sandbox = await sandboxes.resume(name, await network(request));
      return { status: 200, body: sandbox.describe() };
    },
  ),
  route('POST', new RegExp(`^${SANDBOX}/suspend$`), async ({ sandboxes, params: [name = ''] }) => {
    await sandboxes.suspend(name);
    return NO_CONTENT;
  }),
  route('DELETE', new RegExp(`^${SANDBOX}$`), async ({ sandboxes, params: [name = ''] }) => {
    await sandboxes.delete(name);
    return NO_CONTENT;
  }),
  route(
    'POST',
    new RegExp(`^${SANDBOX}/exec$`),
    async ({ sandboxes, params: [name = ''], request, response }) => {
      await execStream(sandboxes.get(name), request, response);
      return undefined;
    },
  ),
  route(
    'GET',
    new RegExp(`^${SANDBOX}/processes/([^/]+)$`),
    ({ sandboxes, params: [name = '', id = ''] }) =>
      waitFor(sandboxes.process(name, id).child.exited),
  ),
  route(
    'DELETE',
    new RegExp(`^${SANDBOX}/processes/([^/]+)$`),
    async ({ sandboxes, params: [name = '', id = ''] }) => {
      await sandboxes.process(name, id).kill();
      return NO_CONTENT;
    },
  ),
  route(
    'DELETE',
    new RegExp(`^${SANDBOX}/processes$`),
    async ({ sandboxes, params: [name = ''] }) => {
      await sandboxes.get(name).killAll();
      return NO_CONTENT;
    },
  ),
  route(
    'POST',
    new RegExp(`^${SANDBOX}/transformations$`),
    async ({ sandboxes, params: [name = ''], request }) => {
      const transformations = transformationList(await readJson(request));
      sandboxes.get(name).transformations.push(...transformations);
      return NO_CONTENT;
    },
  ),
  route(
    'PUT',
    new RegExp(`^${SANDBOX}/transformations$`),
    async ({ sandboxes, params: [name = ''], request }) => {
      sandboxes.get(name).transformations = transformationList(await readJson(request));
      return NO_CONTENT;
    },
  ),
  route(
    'PUT',
    new RegExp(`^${SANDBOX}/network$`),
    async ({ sandboxes, params: [name = ''], request }) => {
      const { allowedHosts = [] } = await network(request);
      sandboxes.setAllowedHosts(name, allowedHosts);
      return NO_CONTENT;
    },
  ),
  route(
    'POST',
    new RegExp(`^${SANDBOX}/template$`),
    async ({ sandboxes, params: [name = ''], request }) => {
      await sandboxes.saveTemplate(name, requiredString(await readJson(request), 'id'));
      return NO_CONTENT;
    },
  ),
  route('GET', /^\/v1\/templates\/([^/]+)$/, async ({ sandboxes, params: [id = ''] }) =>
    (await sandboxes.templateExists(id))
      ? { status: 200, body: { id } }
      : { status: 404, body: { error: `No template "${id}".` } },
  ),
  route('DELETE', /^\/v1\/templates\/([^/]+)$/, async ({ sandboxes, params: [id = ''] }) => {
    await sandboxes.deleteTemplate(id);
    return NO_CONTENT;
  }),
];
