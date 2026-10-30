import type { IncomingMessage, ServerResponse } from 'node:http';

import type { Reply } from '../../common/http-reply.js';
import type { Sandboxes } from '../sandboxes/sandboxes.js';

import {
  offsetOf,
  optionalString,
  readBytes,
  readJson,
  requiredString,
  stringList,
  stringRecord,
  transformationList,
} from '../../common/http-body.js';
import { NO_CONTENT } from '../../common/http-reply.js';
import { PACKAGE_VERSION } from '../../common/package-version.js';
import { MAX_INPUT_WRITE_BYTES } from '../../protocol/api.js';
import { PROTOCOL_VERSION } from '../../protocol/version.js';
import { execRelay } from './exec-relay.js';

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

const network = async (request: IncomingMessage) => {
  const body = await readJson(request);
  return {
    allowedHosts: stringList(body, 'allowedHosts'),
    baseUrls: stringRecord(body, 'baseUrls'),
    template: optionalString(body, 'template'),
    image: optionalString(body, 'image'),
    name: optionalString(body, 'name'),
  };
};

/** The image a template is made on, from the query: the service's default without. */
const imageOf = (request: IncomingMessage): string | undefined =>
  new URL(request.url ?? '/', 'http://service').searchParams.get('image') ?? undefined;

const SANDBOX = '/v1/sandboxes/([^/]+)';

const route = (method: string, path: RegExp, handle: Handler): Route => ({ method, path, handle });

/**
 * The service's API, version 1: the same as `ai-sdk-sandbox-cloud-run`'s. Every route but the
 * health check sits under `/v1`; a sandbox's ports are reached by the tunnel (`port-tunnel.ts`),
 * outside these routes.
 */
export const ROUTES: Route[] = [
  route('GET', /^\/health$/, () =>
    Promise.resolve({
      status: 200,
      body: { status: 'ok', protocol: PROTOCOL_VERSION, version: PACKAGE_VERSION },
    }),
  ),
  // Beyond `ai-sdk-sandbox-cloud-run`'s API: boots what a sandbox will need, ahead of it.
  route('POST', /^\/v1\/prepare$/, async ({ sandboxes, request }) => {
    // An earlier client sends no body: the proxy only.
    const body = await readJson(request);
    await sandboxes.prepare({
      template: optionalString(body, 'template'),
      image: optionalString(body, 'image'),
    });
    return NO_CONTENT;
  }),
  route('POST', /^\/v1\/sandboxes$/, async ({ sandboxes, request }) => {
    const { name, ...options } = await network(request);
    return { status: 201, body: await sandboxes.create(name ?? '', options) };
  }),
  route(
    'POST',
    new RegExp(`^${SANDBOX}/resume$`),
    async ({ sandboxes, params: [name = ''], request }) => ({
      status: 200,
      body: await sandboxes.resume(name, await network(request)),
    }),
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
      await execRelay(sandboxes, name, { request, response });
      return undefined;
    },
  ),
  route(
    'GET',
    new RegExp(`^${SANDBOX}/processes/([^/]+)$`),
    async ({ sandboxes, params: [name = '', id = ''] }) => ({
      status: 200,
      body: await (await sandboxes.agent(name)).wait(id),
    }),
  ),
  route(
    'DELETE',
    new RegExp(`^${SANDBOX}/processes/([^/]+)$`),
    async ({ sandboxes, params: [name = '', id = ''] }) => {
      await (await sandboxes.agent(name)).kill(id);
      return NO_CONTENT;
    },
  ),
  route(
    'POST',
    new RegExp(`^${SANDBOX}/processes/([^/]+)/stdin$`),
    async ({ sandboxes, params: [name = '', id = ''], request }) => {
      const offset = offsetOf(request);
      const bytes = await readBytes(request, MAX_INPUT_WRITE_BYTES);
      await (await sandboxes.agent(name)).writeInput(id, offset, bytes);
      return NO_CONTENT;
    },
  ),
  route(
    'DELETE',
    new RegExp(`^${SANDBOX}/processes/([^/]+)/stdin$`),
    async ({ sandboxes, params: [name = '', id = ''] }) => {
      await (await sandboxes.agent(name)).endInput(id);
      return NO_CONTENT;
    },
  ),
  route(
    'DELETE',
    new RegExp(`^${SANDBOX}/processes$`),
    async ({ sandboxes, params: [name = ''] }) => {
      await (await sandboxes.agent(name)).killAll();
      return NO_CONTENT;
    },
  ),
  route(
    'POST',
    new RegExp(`^${SANDBOX}/transformations$`),
    async ({ sandboxes, params: [name = ''], request }) => {
      await sandboxes.addTransformations(name, transformationList(await readJson(request)));
      return NO_CONTENT;
    },
  ),
  route(
    'PUT',
    new RegExp(`^${SANDBOX}/transformations$`),
    async ({ sandboxes, params: [name = ''], request }) => {
      await sandboxes.setTransformations(name, transformationList(await readJson(request)));
      return NO_CONTENT;
    },
  ),
  route(
    'PUT',
    new RegExp(`^${SANDBOX}/network$`),
    async ({ sandboxes, params: [name = ''], request }) => {
      const { allowedHosts = [] } = await network(request);
      await sandboxes.setAllowedHosts(name, allowedHosts);
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
  route('GET', /^\/v1\/templates\/([^/]+)$/, async ({ sandboxes, params: [id = ''], request }) =>
    (await sandboxes.templateExists(id, imageOf(request)))
      ? { status: 200, body: { id } }
      : { status: 404, body: { error: `No template "${id}".` } },
  ),
  route(
    'DELETE',
    /^\/v1\/templates\/([^/]+)$/,
    async ({ sandboxes, params: [id = ''], request }) => {
      await sandboxes.deleteTemplate(id, imageOf(request));
      return NO_CONTENT;
    },
  ),
];
