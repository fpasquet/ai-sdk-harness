import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { FakeService } from '../../../test/fake-service.js';

import { startFakeService } from '../../../test/fake-service.js';
import { FrameType, readFrames, STDOUT } from '../../protocol/frames.js';
import { PACKAGE_VERSION } from '../package-version.js';

describe('the sandbox service', () => {
  let fake: FakeService;

  /** Calls the service, a JSON body as is or serialized. */
  const call = (method: string, path: string, body?: unknown): Promise<Response> =>
    fetch(`${fake.url}${path}`, {
      method,
      body: body === undefined || typeof body === 'string' ? body : JSON.stringify(body),
    });

  const errorOf = async (response: Response): Promise<[number, string]> => [
    response.status,
    ((await response.json()) as { error: string }).error,
  ];

  beforeEach(async () => {
    fake = await startFakeService();
  });
  afterEach(() => fake.dispose());

  it('answers its health check', async () => {
    const response = await call('GET', '/health');

    expect(await response.json()).toEqual({ status: 'ok', protocol: 2, version: PACKAGE_VERSION });
    expect(response.headers.get('x-ai-sdk-sandbox-protocol')).toBe('2');
  });

  it('answers 404 to an unknown route, 405 to a known one with another method', async () => {
    expect((await call('GET', '/v1/nothing')).status).toBe(404);
    expect((await call('PATCH', '/v1/sandboxes')).status).toBe(405);
  });

  it('refuses bodies that are not what a route takes', async () => {
    expect(await errorOf(await call('POST', '/v1/sandboxes', '{'))).toEqual([
      400,
      'The request body is not JSON.',
    ]);
    expect(await errorOf(await call('POST', '/v1/sandboxes', '[]'))).toEqual([
      400,
      'The request body is not a JSON object.',
    ]);
    expect(await errorOf(await call('POST', '/v1/sandboxes', { name: 1 }))).toEqual([
      400,
      '`name` must be a string.',
    ]);
    expect((await errorOf(await call('POST', '/v1/sandboxes', {})))[1]).toContain(
      'Invalid sandbox name ""',
    );
    expect(
      await errorOf(await call('POST', '/v1/sandboxes', { name: 'box', allowedHosts: 'x' })),
    ).toEqual([400, '`allowedHosts` must be an array of strings.']);
    expect(
      await errorOf(await call('POST', '/v1/sandboxes', { name: 'box', baseUrls: { A: 1 } })),
    ).toEqual([400, '`baseUrls` must be an object of strings.']);
    expect((await call('POST', '/v1/sandboxes', 'x'.repeat(2 << 20))).status).toBe(413);
  });

  it('refuses a template it does not have, or with an invalid name', async () => {
    expect(
      await errorOf(await call('POST', '/v1/sandboxes', { name: 'box', template: 'none' })),
    ).toEqual([404, 'No template "none".']);
    expect((await call('POST', '/v1/sandboxes', { name: 'box', template: 'Bad' })).status).toBe(
      400,
    );
    expect((await call('GET', '/v1/templates/none')).status).toBe(404);
    expect((await call('DELETE', '/v1/templates/none')).status).toBe(204);
  });

  it('saves a running sandbox as a template, which is found and deleted', async () => {
    await call('POST', '/v1/sandboxes', { name: 'box' });

    expect((await call('POST', '/v1/sandboxes/box/template', { id: 'tpl' })).status).toBe(204);
    expect(await (await call('GET', '/v1/templates/tpl')).json()).toEqual({ id: 'tpl' });
    expect((await call('DELETE', '/v1/templates/tpl')).status).toBe(204);
    expect((await call('GET', '/v1/templates/tpl')).status).toBe(404);
  });

  it('refuses transformations without a host or headers', async () => {
    await call('POST', '/v1/sandboxes', { name: 'box' });

    expect(await errorOf(await call('POST', '/v1/sandboxes/box/transformations', {}))).toEqual([
      400,
      '`transformations` must be an array.',
    ]);
    expect(
      (
        await errorOf(
          await call('PUT', '/v1/sandboxes/box/transformations', { transformations: [null] }),
        )
      )[1],
    ).toContain('`transformations[0]` needs');
  });

  it('streams a command, and waits for its process by id', async () => {
    await call('POST', '/v1/sandboxes', { name: 'box' });

    const response = await call(
      'POST',
      '/v1/sandboxes/box/exec',
      `${JSON.stringify({ command: 'cat; exit 5' })}\nstdin`,
    );
    const id = response.headers.get('x-process-id') ?? '';
    const frames = [];
    for await (const frame of readFrames(response.body ?? new Blob().stream())) frames.push(frame);

    expect(frames.map(({ type, channel, payload }) => [type, channel, payload.toString()])).toEqual(
      [
        [FrameType.Open, 0, id],
        [FrameType.Data, STDOUT, 'stdin'],
        [FrameType.Exit, 0, '5'],
      ],
    );
    expect(await (await call('GET', `/v1/sandboxes/box/processes/${id}`)).json()).toEqual({
      exitCode: 5,
    });
    expect((await call('GET', '/v1/sandboxes/box/processes/unknown')).status).toBe(404);
  });

  it('writes the input of a process by offset, nothing twice and with no gap', async () => {
    await call('POST', '/v1/sandboxes', { name: 'box' });
    const response = await call(
      'POST',
      '/v1/sandboxes/box/exec',
      `${JSON.stringify({ command: 'cat', stdin: true })}\n`,
    );
    const id = response.headers.get('x-process-id') ?? '';
    const stdin = `/v1/sandboxes/box/processes/${id}/stdin`;

    expect((await call('POST', `${stdin}?offset=0`, 'ab')).status).toBe(204);
    // Sent again, then again with more: only what is new is written.
    expect((await call('POST', `${stdin}?offset=0`, 'ab')).status).toBe(204);
    expect((await call('POST', `${stdin}?offset=1`, 'bc')).status).toBe(204);
    expect(await errorOf(await call('POST', `${stdin}?offset=5`, 'x'))).toEqual([
      409,
      'The input of the process is at byte 3, not 5: a write is missing.',
    ]);
    expect((await call('POST', stdin, 'x')).status).toBe(400);
    expect((await call('DELETE', stdin)).status).toBe(204);
    expect((await call('DELETE', stdin)).status).toBe(204);
    expect((await call('POST', `${stdin}?offset=3`, 'd')).status).toBe(409);

    const output = [];
    for await (const { type, payload } of readFrames(response.body ?? new Blob().stream())) {
      if (type === FrameType.Data) output.push(payload.toString());
    }
    expect(output.join('')).toBe('abc');
  });

  it('refuses to write the input of a process started without stdin', async () => {
    await call('POST', '/v1/sandboxes', { name: 'box' });
    const response = await call('POST', '/v1/sandboxes/box/exec', '{"command":"sleep 1"}\n');
    const id = response.headers.get('x-process-id') ?? '';

    expect(
      await errorOf(await call('POST', `/v1/sandboxes/box/processes/${id}/stdin?offset=0`, 'x')),
    ).toEqual([409, `The process ${id} was started without a writable standard input.`]);
    expect((await call('DELETE', `/v1/sandboxes/box/processes/${id}/stdin`)).status).toBe(409);
    expect((await call('DELETE', '/v1/sandboxes/box/processes/unknown/stdin')).status).toBe(404);
    await response.body?.cancel();
  });

  it('refuses a command it cannot read, or in a sandbox that does not run', async () => {
    await call('POST', '/v1/sandboxes', { name: 'box' });

    expect((await call('POST', '/v1/sandboxes/box/exec', 'no newline')).status).toBe(400);
    expect((await call('POST', '/v1/sandboxes/box/exec', '{"command":1}\n')).status).toBe(400);
    expect((await call('POST', '/v1/sandboxes/ghost/exec', '{"command":"true"}\n')).status).toBe(
      404,
    );
    expect((await call('POST', '/v1/sandboxes/box/exec', 'x'.repeat(2 << 20))).status).toBe(413);
    const env = '{"command":"true","env":{"NOT-VALID":"x"}}\n';
    expect(await errorOf(await call('POST', '/v1/sandboxes/box/exec', env))).toEqual([
      400,
      'Invalid variable name: NOT-VALID',
    ]);
  });

  it('answers 500, and keeps serving, when the runtime fails', async () => {
    await call('POST', '/v1/sandboxes', { name: 'box' });
    // Gone behind the service's back: the CLI fails to snapshot it.
    await import('node:fs').then(({ rmSync }) =>
      rmSync(`${process.env['FAKE_SANDBOX_STATE']}/box.sandbox`),
    );

    const [status, message] = await errorOf(await call('POST', '/v1/sandboxes/box/suspend'));

    expect(status).toBe(500);
    expect(message).toContain('`sandbox tar` exited with 1');
    expect((await call('GET', '/health')).status).toBe(200);
  });
});
