import type { IncomingHttpHeaders, Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createServer } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PROTOCOL_HEADER, PROTOCOL_VERSION } from '../../protocol/version.js';
import { ProxyAdmin } from './proxy-admin.js';

interface Call {
  method?: string;
  url?: string;
  headers: IncomingHttpHeaders;
  body: string;
}

describe('the client of the egress proxy administration API', () => {
  let server: Server;
  let url: string;
  let calls: Call[];
  let answer: [number, string];

  beforeEach(async () => {
    calls = [];
    answer = [204, ''];
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const { method, url: path, headers } = request;
        calls.push({ method, url: path, headers, body: Buffer.concat(chunks).toString() });
        response.writeHead(answer[0]).end(answer[1]);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );

  it('calls each route with its token and protocol', async () => {
    const admin = new ProxyAdmin(`${url}/`, 'proxy-token');
    const transformation = { match: { host: 'h' }, transform: { headers: {} } };

    await admin.register('box', { address: '10.0.0.3', allowedHosts: [], baseUrls: {} });
    await admin.setAllowedHosts('box', ['github.com']);
    await admin.addTransformations('box', [transformation]);
    await admin.setTransformations('box', []);
    await admin.remove('box');

    expect(calls.map(({ method, url: path }) => `${method} ${path}`)).toEqual([
      'PUT /v1/sandboxes/box',
      'PUT /v1/sandboxes/box/network',
      'POST /v1/sandboxes/box/transformations',
      'PUT /v1/sandboxes/box/transformations',
      'DELETE /v1/sandboxes/box',
    ]);
    expect(calls[0]?.headers).toMatchObject({
      authorization: 'Bearer proxy-token',
      [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
      'content-type': 'application/json',
    });
    expect(calls[1]?.body).toBe('{"allowedHosts":["github.com"]}');
    expect(calls[4]?.headers['content-type']).toBeUndefined();
  });

  it('lists the sandboxes of the proxy, and none of a proxy too old to', async () => {
    const admin = new ProxyAdmin(url, 'proxy-token');
    const sandbox = { name: 'box', address: '10.0.0.3', serial: 4 };

    answer = [200, JSON.stringify({ sandboxes: [sandbox] })];
    await expect(admin.list()).resolves.toEqual([sandbox]);
    await admin.remove('box', 4);
    answer = [404, '{"error":"No route for GET /v1/sandboxes."}'];
    await expect(admin.list()).resolves.toBeUndefined();
    answer = [500, 'broken'];
    await expect(admin.list()).rejects.toMatchObject({ status: 502 });

    expect(calls.map(({ method, url: path }) => `${method} ${path}`).slice(0, 2)).toEqual([
      'GET /v1/sandboxes',
      'DELETE /v1/sandboxes/box?serial=4',
    ]);
  });

  it('asks whether texts hold a credential of the sandbox', async () => {
    const admin = new ProxyAdmin(url, 'proxy-token');

    answer = [200, '{"refused":true}'];
    await expect(admin.holdsSecret('box', ['echo secret'])).resolves.toBe(true);
    answer = [200, '{}'];
    await expect(admin.holdsSecret('box', ['echo'])).resolves.toBe(false);
  });

  it('says a sandbox the proxy does not know is not found, any other refusal a 502', async () => {
    const admin = new ProxyAdmin(url, 'proxy-token');

    answer = [404, '{"error":"The proxy knows no sandbox \\"box\\"."}'];
    await expect(admin.setAllowedHosts('box', [])).rejects.toMatchObject({
      status: 404,
      message: 'Egress proxy: The proxy knows no sandbox "box".',
    });
    answer = [500, ' broken '];
    await expect(admin.remove('box')).rejects.toMatchObject({
      status: 502,
      message: 'Egress proxy: broken',
    });
  });

  it('says whether the proxy answers its health', async () => {
    answer = [200, '{"status":"ok"}'];
    expect(await new ProxyAdmin(url, 'a-token').healthy()).toBe(true);
    answer = [503, ''];
    expect(await new ProxyAdmin(url, 'a-token').healthy()).toBe(false);
    expect(await new ProxyAdmin('http://127.0.0.1:1', 'a-token').healthy()).toBe(false);
    expect(calls.at(-1)?.url).toBe('/health');
  });

  it('cannot reach a proxy that is gone', async () => {
    await new Promise((resolve) => server.close(resolve));

    await expect(new ProxyAdmin(url, 'proxy-token').remove('box')).rejects.toMatchObject({
      status: 502,
      message: expect.stringContaining('The egress proxy could not be reached') as unknown,
    });
  });
});
