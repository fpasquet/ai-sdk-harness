import type { AddressInfo } from 'node:net';

import { createServer } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AccessToken } from './access-token.js';
import { ComputeApi } from './compute-api.js';

describe('the Compute Engine API', () => {
  let server: ReturnType<typeof createServer>;
  let endpoint: string;
  let answers: Record<string, unknown>[];
  let calls: string[];
  let authorizations: (string | undefined)[];

  beforeEach(async () => {
    calls = [];
    answers = [];
    authorizations = [];
    server = createServer((request, response) => {
      calls.push(`${request.method} ${request.url}`);
      authorizations.push(request.headers.authorization);
      const answer = answers.shift() ?? {};
      const status = typeof answer['status'] === 'number' ? answer['status'] : 200;
      // Not JSON: what a proxy in front of the API may answer.
      if (typeof answer['text'] === 'string')
        return void response.writeHead(status).end(answer['text']);
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

  it('only starts an operation when not told to wait, but reads one already failed', async () => {
    answers.push(
      { name: 'op', status: 'RUNNING', selfLink: `${endpoint}/op` },
      {
        name: 'op',
        status: 'DONE',
        selfLink: `${endpoint}/op`,
        httpErrorStatusCode: 400,
        error: { errors: [{ code: 'INVALID', message: 'no' }] },
      },
      { name: 'op', status: 'DONE', selfLink: `${endpoint}/op` },
    );

    await api().deleteInstance('box', { wait: false });
    await expect(api().stopInstance('box', { wait: false })).rejects.toMatchObject({ status: 400 });
    await api().setScheduling('box', { provisioningModel: 'STANDARD' });

    expect(calls).toEqual([
      'DELETE /projects/p/zones/z/instances/box',
      'POST /projects/p/zones/z/instances/box/stop',
      'POST /projects/p/zones/z/instances/box/setScheduling',
    ]);
  });

  it('lists the instances of a label, every page of them', async () => {
    answers.push(
      { items: [{ name: 'a', status: 'RUNNING' }], nextPageToken: 'next' },
      { items: [{ name: 'b', status: 'TERMINATED' }] },
    );

    const instances = await api().listInstances('ai-sdk-sandbox', 'sandbox');

    expect(instances.map(({ name }) => name)).toEqual(['a', 'b']);
    expect(calls).toEqual([
      'GET /projects/p/zones/z/instances?filter=labels.ai-sdk-sandbox+%3D+%22sandbox%22',
      'GET /projects/p/zones/z/instances?filter=labels.ai-sdk-sandbox+%3D+%22sandbox%22&pageToken=next',
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
      code: 'QUOTA_EXCEEDED',
      outOfCapacity: false,
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

  it('changes metadata read with its fingerprint, and refuses metadata changed since', async () => {
    answers.push(
      { name: 'op', status: 'DONE', selfLink: `${endpoint}/op` },
      { status: 412, error: { message: 'Supplied fingerprint does not match current metadata' } },
    );
    const metadata = { fingerprint: 'abc=', items: [{ key: 'k', value: 'v' }] };

    await api().setMetadata('box', metadata);
    await expect(api().setMetadata('box', metadata)).rejects.toMatchObject({ status: 412 });

    expect(calls[0]).toBe('POST /projects/p/zones/z/instances/box/setMetadata');
  });

  it('reports a failed operation that says little, and an error that is not JSON', async () => {
    answers.push(
      { name: 'op', status: 'DONE', selfLink: `${endpoint}/op`, error: { errors: [{}] } },
      { status: 502, text: ' Bad Gateway ' },
    );

    await expect(api().startInstance('box')).rejects.toMatchObject({
      status: 500,
      message: 'Compute Engine: ERROR: the operation failed.',
    });
    await expect(api().resumeInstance('box')).rejects.toMatchObject({
      status: 502,
      message: 'Compute Engine: Bad Gateway',
    });
  });

  it('gives up an operation that never ends, and sends its token on every call', async () => {
    const token = { get: () => Promise.resolve('ya29.token') } as unknown as AccessToken;
    const now = Date.now();
    const clock = vi
      .spyOn(Date, 'now')
      .mockReturnValueOnce(now)
      .mockReturnValue(now + 16 * 60_000);
    answers.push({ name: 'op', status: 'RUNNING', selfLink: `${endpoint}/op` });

    await expect(
      new ComputeApi({ endpoint, project: 'p', zone: 'z', token }).insertImage('img', 'disk', {}),
    ).rejects.toMatchObject({
      status: 504,
      message: 'Compute Engine: operation op is still running.',
    });
    clock.mockRestore();
    expect(authorizations).toEqual(['Bearer ya29.token']);
  });
});
