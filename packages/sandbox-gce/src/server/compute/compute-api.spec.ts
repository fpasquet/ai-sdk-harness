import type { AddressInfo } from 'node:net';

import { createServer } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AccessToken } from './access-token.js';
import { ComputeApi } from './compute-api.js';

describe('the Compute Engine API', () => {
  let server: ReturnType<typeof createServer>;
  let endpoint: string;
  let answers: Record<string, unknown>[];
  let calls: string[];

  beforeEach(async () => {
    calls = [];
    answers = [];
    server = createServer((request, response) => {
      calls.push(`${request.method} ${request.url}`);
      const answer = answers.shift() ?? {};
      const status = typeof answer['status'] === 'number' ? answer['status'] : 200;
      response
        .writeHead(status, { 'content-type': 'application/json' })
        .end(JSON.stringify(answer));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(() => new Promise((resolve) => server.close(resolve)));

  const api = (): ComputeApi =>
    new ComputeApi({ endpoint, project: 'p', zone: 'z', token: new AccessToken('none') });

  it('waits for an operation until it is done', async () => {
    answers.push(
      { name: 'op', status: 'RUNNING', selfLink: `${endpoint}/projects/p/zones/z/operations/op` },
      { name: 'op', status: 'RUNNING', selfLink: `${endpoint}/projects/p/zones/z/operations/op` },
      { name: 'op', status: 'DONE', selfLink: `${endpoint}/projects/p/zones/z/operations/op` },
    );

    await api().stopInstance('box');

    expect(calls).toEqual([
      'POST /projects/p/zones/z/instances/box/stop',
      'POST /projects/p/zones/z/operations/op/wait',
      'POST /projects/p/zones/z/operations/op/wait',
    ]);
  });

  it('reports a failed operation with its status', async () => {
    answers.push({
      name: 'op',
      status: 'DONE',
      selfLink: `${endpoint}/op`,
      httpErrorStatusCode: 403,
      error: { errors: [{ code: 'QUOTA_EXCEEDED', message: 'CPUS quota exceeded' }] },
    });

    await expect(api().insertInstance({ name: 'box' })).rejects.toMatchObject({
      status: 403,
      message: 'Compute Engine: QUOTA_EXCEEDED: CPUS quota exceeded',
    });
  });

  it('reads a missing resource as none, and a refused call as an error', async () => {
    answers.push({ status: 404 }, { status: 403, error: { message: 'Required permission' } });

    expect(await api().getInstance('ghost')).toBeUndefined();
    await expect(api().getImage('projects/p/global/images/x')).rejects.toMatchObject({
      status: 403,
      message: 'Compute Engine: Required permission',
    });
  });

  it('deletes what is already gone without an error', async () => {
    answers.push({ status: 404 }, { status: 404 });

    await api().deleteInstance('ghost');
    await api().deleteImage('ghost');

    expect(calls).toEqual([
      'DELETE /projects/p/zones/z/instances/ghost',
      'DELETE /projects/p/global/images/ghost',
    ]);
  });
});
