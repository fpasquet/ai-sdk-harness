import type { HarnessV1RequestTransformation, HarnessV1SandboxTemplate } from '@ai-sdk/harness';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FakeSbx } from '../../test/fake-sbx.js';

import { createFakeSbx } from '../../test/fake-sbx.js';
import { createSbxNetworkSandboxSession, resumeSbxNetworkSandboxSession } from '../index.js';
import { findPortUrl } from '../network/port-publisher.js';
import { templateReference } from './sandbox-template.js';

const anthropicTransformation = (placeholder: string): HarnessV1RequestTransformation => ({
  match: {
    host: 'api.anthropic.com',
    headers: [{ key: { exact: 'authorization' }, value: { exact: `Bearer ${placeholder}` } }],
  },
  transform: { headers: { authorization: 'Bearer real-token' } },
});

describe('cloud sandboxes', () => {
  let sbx: FakeSbx;

  beforeEach(() => {
    sbx = createFakeSbx();
  });
  afterEach(() => sbx.dispose());

  const create = (settings: object = {}) =>
    createSbxNetworkSandboxSession({
      binary: sbx.binary,
      cloud: true,
      sandboxId: 'box',
      ...settings,
    });

  it('sends every command to Docker Sandboxes Cloud', async () => {
    const session = await create();

    expect(session.cloud).toBe(true);
    expect(sbx.calls().every(([first]) => first === '--cloud')).toBe(true);
  });

  it('passes the cloud creation settings to sbx create', async () => {
    await create({
      allowNetwork: ['api.example.com'],
      denyNetwork: ['github.com'],
      ttl: '2h',
      onTimeout: 'stop',
      platform: 'linux/arm64',
      cpus: 4,
      memory: '8g',
    });

    expect(sbx.callsOf('create')[0]).toEqual([
      '--cloud',
      'create',
      '--name',
      'box',
      '--quiet',
      '--cpus',
      '4',
      '--memory',
      '8g',
      '--platform',
      'linux/arm64',
      '--deny-network',
      'github.com',
      '--allow-network',
      'api.example.com',
      '--ttl',
      '2h',
      '--on-timeout',
      'stop',
      'shell',
    ]);
  });

  it('refuses what a cloud sandbox cannot do, before creating anything', async () => {
    await expect(create({ workspace: '/repo' })).rejects.toThrow(/mounts nothing of this host/);
    await expect(create({ sandboxId: 'with.period' })).rejects.toThrow(/not a valid sandbox id/);
    expect(sbx.callsOf('create')).toEqual([]);
  });

  it('refuses cloud settings on a local sandbox', async () => {
    await expect(
      createSbxNetworkSandboxSession({ binary: sbx.binary, sandboxId: 'box', ttl: '1h' }),
    ).rejects.toThrow(/only apply to a cloud sandbox/);
  });

  it('runs the setup commands without --user, which the cloud refuses', async () => {
    await create({ setup: ['echo ready'] });

    expect(sbx.callsOf('exec').filter((call) => call.at(-1) === 'echo ready')).toEqual([
      ['--cloud', 'exec', 'box', 'sh', '-c', 'echo ready'],
    ]);
  });

  it('reaches an exposed port at the public URL the control plane assigns', async () => {
    const session = await create({ ports: [4000] });

    const bridge = await session.getPortEndpoint({ port: 4000, protocol: 'ws' });
    const http = await session.getPortEndpoint({ port: 4000 });

    expect(bridge.url).toBe('wss://box-4000.sbx.example');
    expect(http.url).toBe('https://box-4000.sbx.example');
    expect(sbx.callsOf('ports').filter((call) => call.includes('--publish'))).toEqual([
      ['--cloud', 'ports', 'box', '--publish', '4000'],
    ]);

    await session.release();
    expect(sbx.state().ports).toEqual([]);
  });

  it('has the proxy set the whole header, under a secret named after the sandbox', async () => {
    const session = await create();

    await session.addRequestTransformations?.([anthropicTransformation('placeholder')]);
    await session.setRequestTransformations?.([anthropicTransformation('another')]);

    expect(sbx.state().secrets).toEqual([
      {
        scope: 'box',
        name: 'box-api-anthropic-com-authorization',
        header: 'authorization',
        format: '%s',
        targets: ['api.anthropic.com'],
        value: 'Bearer real-token',
      },
    ]);
    await session.release();
    expect(sbx.state().secrets).toEqual([]);
  });

  it('withdraws a secret the views of a sandbox share once the last of them releases it', async () => {
    const session = await create();
    const view = session.fork({ ports: [4001] });
    await session.addRequestTransformations?.([anthropicTransformation('root')]);
    await view.addRequestTransformations?.([anthropicTransformation('view')]);

    await view.release();
    expect(sbx.state().secrets.map(({ name }) => name)).toEqual([
      'box-api-anthropic-com-authorization',
    ]);

    await session.release();
    expect(sbx.state().secrets).toEqual([]);
  });

  it('removes its secrets with the sandbox: they belong to the account', async () => {
    const session = await create();
    await session.addRequestTransformations?.([anthropicTransformation('placeholder')]);

    await session.destroy();

    expect(sbx.state().secrets).toEqual([]);
    expect(sbx.state().sandboxes).toEqual({});
  });

  it('extends the time-to-live of a cloud sandbox, and of a cloud sandbox only', async () => {
    const session = await create();
    const local = await createSbxNetworkSandboxSession({ binary: sbx.binary, sandboxId: 'local' });

    await session.extendTtl('2h');

    expect(sbx.callsOf('ttl')).toEqual([['--cloud', 'ttl', '+2h', 'box']]);
    await expect(local.extendTtl('2h')).rejects.toThrow(/Only a cloud sandbox/);
  });

  it('finds a cloud sandbox again by name or by id', async () => {
    sbx.addSandbox('box');

    const byName = await resumeSbxNetworkSandboxSession({
      binary: sbx.binary,
      cloud: true,
      sandboxId: 'box',
    });

    expect(byName.cloud).toBe(true);
    await expect(
      resumeSbxNetworkSandboxSession({ binary: sbx.binary, cloud: true, sandboxId: 'sbx_box' }),
    ).resolves.toBeDefined();
  });

  it('bakes the template into the cloud registry, snapshotting the sandbox while it runs', async () => {
    const template: HarnessV1SandboxTemplate = { identity: 'cloud-recipe', prepare: vi.fn() };

    await create({ template });
    await create({ sandboxId: 'second', template });

    const name = templateReference({ template, agent: 'shell', setup: [] }, true);
    expect(name).toMatch(/^ai-sdk-harness-template-[0-9a-f]{24}$/);
    expect(template.prepare).toHaveBeenCalledTimes(1);
    expect(sbx.state().cloudTemplates).toEqual([name]);
    expect(sbx.callsOf('stop')).toEqual([]);
    expect(sbx.callsOf('create')[1]).toEqual([
      '--cloud',
      'create',
      '--name',
      'box',
      '--quiet',
      '--template',
      name,
      'shell',
    ]);
  });
});

describe('findPortUrl', () => {
  it('finds the URL of a port, whatever the shape of the listing', () => {
    expect(findPortUrl({ ports: [{ sandbox_port: 4000, url: 'https://a' }] }, 4000)).toBe(
      'https://a',
    );
    expect(findPortUrl([{ port: '4000/tcp', endpoint: 'https://b' }], 4000)).toBeUndefined();
    expect(findPortUrl([{ port: 4000, endpoint: 'https://b' }], 4000)).toBe('https://b');
    expect(
      findPortUrl({ items: { a: { sandboxPort: 5000, url: 'https://c' } } }, 4000),
    ).toBeUndefined();
    expect(findPortUrl('nothing', 4000)).toBeUndefined();
  });
});
