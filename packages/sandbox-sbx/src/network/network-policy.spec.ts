import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { FakeSbx } from '../../test/fake-sbx.js';

import { createFakeSbx } from '../../test/fake-sbx.js';
import { createSbxNetworkSandboxSession, resumeSbxNetworkSandboxSession } from '../index.js';

describe('the network policy of a Docker Sandbox', () => {
  let sbx: FakeSbx;

  beforeEach(() => {
    sbx = createFakeSbx();
  });
  afterEach(() => sbx.dispose());

  /** The rules scoped to `sandbox`: what each allows or denies. */
  const scoped = (sandbox: string) =>
    sbx
      .state()
      .rules.filter(({ scope }) => scope === `sandbox:${sandbox}`)
      .map(({ decision, protocol, resources }) => ({ decision, protocol, resources }));

  it('denies every host with deny-all, before the setup runs', async () => {
    await createSbxNetworkSandboxSession({
      binary: sbx.binary,
      sandboxId: 'box',
      networkPolicy: { mode: 'deny-all' },
      setup: ['true'],
    });

    expect(scoped('box')).toEqual([{ decision: 'deny', protocol: 'tcp,udp', resources: ['**'] }]);
    const order = sbx.calls().map(([command]) => command);
    expect(order.indexOf('policy')).toBeLessThan(order.indexOf('exec'));
  });

  it('allows the listed hosts only, denying what the machine allows besides', async () => {
    const session = await createSbxNetworkSandboxSession({ binary: sbx.binary, sandboxId: 'box' });

    await session.setNetworkPolicy?.({
      mode: 'custom',
      allowedHosts: ['api.anthropic.com', '*.github.com'],
      allowedCIDRs: ['203.0.113.0/24'],
      deniedCIDRs: ['198.51.100.0/24'],
    });

    expect(scoped('box')).toEqual([
      { decision: 'allow', protocol: 'tcp', resources: ['api.anthropic.com', '**.github.com'] },
      { decision: 'allow', protocol: 'tcp,udp', resources: ['203.0.113.0/24'] },
      {
        decision: 'deny',
        protocol: 'tcp,udp',
        // What the listed hosts cover, github.com included, or what covers them, is left alone:
        // a deny would win over their allow.
        resources: ['198.51.100.0/24', '**.openai.com:443', 'registry.npmjs.org:443'],
      },
    ]);
  });

  it('replaces its previous rules, and leaves the machine policy as it is with allow-all', async () => {
    const session = await createSbxNetworkSandboxSession({
      binary: sbx.binary,
      sandboxId: 'box',
      networkPolicy: { mode: 'deny-all' },
    });

    await session.setNetworkPolicy?.({ mode: 'custom', allowedHosts: ['example.com'] });
    expect(scoped('box').map(({ decision }) => decision)).toEqual(['allow', 'deny']);

    await session.setNetworkPolicy?.({ mode: 'allow-all' });
    expect(scoped('box')).toEqual([]);
    // Allowing every host would lift the proxy's own fence around private networks.
    await session.setNetworkPolicy?.({ mode: 'custom', allowedHosts: ['*'] });
    expect(scoped('box')).toEqual([]);
    expect(sbx.state().rules.map(({ id }) => id)).toEqual([
      'default-ai-services',
      'default-package-managers',
    ]);
  });

  it('keeps the rules of a resumed sandbox, and of other sandboxes', async () => {
    await createSbxNetworkSandboxSession({
      binary: sbx.binary,
      sandboxId: 'other',
      networkPolicy: { mode: 'deny-all' },
    });
    await createSbxNetworkSandboxSession({ binary: sbx.binary, sandboxId: 'box' });
    const resumed = await resumeSbxNetworkSandboxSession({ binary: sbx.binary, sandboxId: 'box' });

    await resumed.setNetworkPolicy?.({ mode: 'custom', allowedHosts: ['api.anthropic.com'] });

    expect(scoped('other')).toHaveLength(1);
    // The denies of a custom policy are the machine's allows, never another sandbox's rules.
    expect(scoped('box').at(-1)?.resources).not.toContain('**');
  });

  it('goes with its sandbox', async () => {
    const session = await createSbxNetworkSandboxSession({
      binary: sbx.binary,
      sandboxId: 'box',
      networkPolicy: { mode: 'deny-all' },
    });

    await session.destroy();

    expect(scoped('box')).toEqual([]);
  });

  it('is left to the account in the cloud', async () => {
    await expect(
      createSbxNetworkSandboxSession({
        binary: sbx.binary,
        sandboxId: 'box',
        cloud: true,
        networkPolicy: { mode: 'deny-all' },
      }),
    ).rejects.toThrow('`networkPolicy`: only apply to a local sandbox');

    const cloud = await createSbxNetworkSandboxSession({
      binary: sbx.binary,
      sandboxId: 'box',
      cloud: true,
    });
    expect(cloud.setNetworkPolicy).toBeUndefined();
  });
});
