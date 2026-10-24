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

  /** The rules scoped to `sandbox`: what each allows or denies, over which protocol. */
  const scoped = (sandbox: string) =>
    sbx
      .state()
      .rules.filter(({ scope }) => scope === `sandbox:${sandbox}`)
      .flatMap(({ decision, resources, actions }) =>
        resources.flatMap((resource) =>
          actions.map((action) => `${decision} ${resource} ${action.replace('net:connect:', '')}`),
        ),
      );

  it('denies every host with deny-all, before the setup runs', async () => {
    await createSbxNetworkSandboxSession({
      binary: sbx.binary,
      sandboxId: 'box',
      networkPolicy: { mode: 'deny-all' },
      setup: ['true'],
    });

    expect(scoped('box')).toEqual(['deny ** tcp', 'deny ** udp']);
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
      'allow api.anthropic.com tcp',
      'allow **.github.com tcp',
      'allow 203.0.113.0/24 tcp',
      'allow 203.0.113.0/24 udp',
      'deny 198.51.100.0/24 tcp',
      'deny 198.51.100.0/24 udp',
      // What the listed hosts cover, github.com included, or what covers them, is left alone: a
      // deny would win over their allow.
      'deny **.openai.com:443 tcp',
      'deny **.openai.com:443 udp',
      'deny registry.npmjs.org:443 tcp',
      'deny registry.npmjs.org:443 udp',
    ]);
  });

  it('replaces its previous rules, and leaves the machine policy as it is with allow-all', async () => {
    const session = await createSbxNetworkSandboxSession({
      binary: sbx.binary,
      sandboxId: 'box',
      networkPolicy: { mode: 'deny-all' },
    });

    await session.setNetworkPolicy?.({ mode: 'custom', allowedHosts: ['example.com'] });
    expect(scoped('box')).toContain('allow example.com tcp');
    expect(scoped('box')).not.toContain('deny ** tcp');

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

  it('keeps the rules a policy applied again still holds', async () => {
    const policy = { mode: 'custom', allowedHosts: ['api.anthropic.com'] } as const;
    const session = await createSbxNetworkSandboxSession({
      binary: sbx.binary,
      sandboxId: 'box',
      networkPolicy: policy,
    });
    const applied = scoped('box');

    // `sbx` adds no rule for a host it has one for: removing the previous ones would leave none.
    await session.setNetworkPolicy?.(policy);
    expect(scoped('box')).toEqual(applied);

    await session.setNetworkPolicy?.({ mode: 'custom', allowedHosts: ['example.com'] });
    expect(scoped('box')).toContain('allow example.com tcp');
    expect(scoped('box')).not.toContain('allow api.anthropic.com tcp');
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

    expect(scoped('other')).toEqual(['deny ** tcp', 'deny ** udp']);
    // The denies of a custom policy are the machine's allows, never another sandbox's rules.
    expect(scoped('box')).not.toContain('deny ** tcp');
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
