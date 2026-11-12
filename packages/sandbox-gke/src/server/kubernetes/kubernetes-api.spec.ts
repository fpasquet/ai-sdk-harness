import type { IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';

import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { KubernetesCredentials } from './credentials.js';
import { KubernetesApi } from './kubernetes-api.js';
import { KubernetesError } from './kubernetes-error.js';

interface Call {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

describe('the Kubernetes API', () => {
  let server: ReturnType<typeof createServer>;
  let endpoint: string;
  let answers: { status: number; body: unknown }[];
  let calls: Call[];

  beforeEach(async () => {
    calls = [];
    answers = [];
    server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk: Buffer) => (body += chunk.toString()));
      request.on('end', () => {
        calls.push({
          method: request.method ?? '',
          url: request.url ?? '',
          headers: request.headers,
          body,
        });
        const answer = answers.shift() ?? { status: 200, body: {} };
        response
          .writeHead(answer.status, { 'content-type': 'application/json' })
          .end(JSON.stringify(answer.body));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(() => new Promise((resolve) => server.close(resolve)));

  const api = (credentials = new KubernetesCredentials('none')): KubernetesApi =>
    new KubernetesApi({ endpoint, namespace: 'sandboxes', credentials });

  it('reads a sandbox of its namespace, and nothing when there is none', async () => {
    answers.push({ status: 200, body: { metadata: { name: 'sbx-box' }, spec: {} } });
    answers.push({ status: 404, body: { kind: 'Status', message: 'not found' } });

    expect(await api().getSandbox('sbx-box')).toMatchObject({ metadata: { name: 'sbx-box' } });
    expect(await api().getSandbox('sbx-none')).toBeUndefined();
    expect(calls.map(({ method, url }) => `${method} ${url}`)).toEqual([
      'GET /apis/agents.x-k8s.io/v1beta1/namespaces/sandboxes/sandboxes/sbx-box',
      'GET /apis/agents.x-k8s.io/v1beta1/namespaces/sandboxes/sandboxes/sbx-none',
    ]);
  });

  it('merges a patch, with the service account token', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'service-account-'));
    writeFileSync(join(directory, 'ca.crt'), 'certificate');
    writeFileSync(join(directory, 'token'), 'the-token');

    await api(new KubernetesCredentials('service-account', directory)).patchSandbox('sbx-box', {
      spec: { operatingMode: 'Suspended' },
    });

    expect(calls[0]).toMatchObject({
      method: 'PATCH',
      headers: {
        'content-type': 'application/merge-patch+json',
        authorization: 'Bearer the-token',
      },
      body: '{"spec":{"operatingMode":"Suspended"}}',
    });
  });

  it('throws what the API answered, its status kept, but for a deletion of nothing', async () => {
    answers.push({ status: 409, body: { kind: 'Status', message: 'sandboxes "sbx-box" exists' } });
    answers.push({ status: 404, body: { kind: 'Status', message: 'not found' } });

    const error = await api()
      .createSandbox({ metadata: { name: 'sbx-box' } })
      .catch((caught: unknown) => caught);
    await api().deleteSnapshot('gone');

    expect(error).toBeInstanceOf(KubernetesError);
    expect(error).toMatchObject({ status: 409 });
    expect(String(error)).toContain('sandboxes "sbx-box" exists');
  });
});
