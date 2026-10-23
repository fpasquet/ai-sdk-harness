import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { FakeSbx, PolicyLogEntry } from '../../test/fake-sbx.js';

import { createFakeSbx } from '../../test/fake-sbx.js';
import { createSbxNetworkSandboxSession, resumeSbxNetworkSandboxSession } from '../index.js';
import { SbxCli } from '../transport/sbx-cli.js';
import { blockedRequests } from './blocked-requests.js';

/** An entry of the proxy's log for `box`, seen once at `at`. */
const entry = (host: string, at: string, change: Partial<PolicyLogEntry> = {}): PolicyLogEntry => ({
  sandbox_id: 'box',
  host,
  proxy_type: 'forward',
  rule: 'no applicable policies for op(action=net:connect:tcp, resource=net:domain:…)',
  reason: 'No matching allow rule (default deny)',
  count: 1,
  first_seen: at,
  last_seen: at,
  ...change,
});

describe('the requests the proxy refused to a Docker Sandbox', () => {
  let sbx: FakeSbx;

  beforeEach(() => {
    sbx = createFakeSbx();
    // As `sbx` 0.48 logged them, refusals of a lookup included.
    sbx.update((state) => {
      state.policyLog = {
        allowed: [entry('api.anthropic.com:443', '2026-10-23T17:07:58.46+02:00')],
        blocked: [
          entry('example.com:443', '2026-10-23T17:08:04.485291193+02:00'),
          entry('api.github.com:443', '2026-10-23T17:08:16.947317902+02:00', {
            reason: 'Denied by local rule',
            count: 2,
            last_seen: '2026-10-23T17:08:17.449269952+02:00',
          }),
          entry('[2001:db8::1]:8443', '2026-10-23T17:08:10+02:00'),
          entry('www.wikipedia.org', '2026-10-23T17:08:59+02:00', {
            proxy_type: 'network',
            reason: 'DNS lookup blocked by proxy policy',
          }),
          entry('www.wikipedia.org.box.docker.internal', '2026-10-23T17:08:59+02:00', {
            proxy_type: 'network',
            reason: 'DNS lookup blocked by proxy policy',
          }),
          entry('0.0.0.0.in-addr.arpa', '2026-10-23T17:08:01+02:00', {
            proxy_type: 'network',
            reason: 'PTR lookup blocked by proxy policy',
          }),
          entry('neverssl.com:80', '2026-10-23T17:08:18+02:00', { sandbox_id: 'other' }),
        ],
      };
    });
  });
  afterEach(() => sbx.dispose());

  it('lists the hosts refused to this sandbox, the last refused first', async () => {
    const session = await createSbxNetworkSandboxSession({ binary: sbx.binary, sandboxId: 'box' });

    const blocked = await session.blockedRequests?.();

    expect(blocked).toEqual([
      {
        host: 'www.wikipedia.org',
        reason: 'DNS lookup blocked by proxy policy',
        count: 1,
        firstSeen: new Date('2026-10-23T15:08:59Z'),
        lastSeen: new Date('2026-10-23T15:08:59Z'),
      },
      {
        host: 'api.github.com',
        port: 443,
        reason: 'Denied by local rule',
        count: 2,
        firstSeen: new Date('2026-10-23T15:08:16.947Z'),
        lastSeen: new Date('2026-10-23T15:08:17.449Z'),
      },
      expect.objectContaining({ host: '2001:db8::1', port: 8443 }),
      expect.objectContaining({ host: 'example.com', port: 443 }),
    ]);
    expect(sbx.callsOf('policy')).toContainEqual([
      'policy',
      'log',
      'box',
      '--type',
      'network',
      '--json',
    ]);
  });

  it('leaves out what was refused before `since`', async () => {
    sbx.addSandbox('box');
    const session = await resumeSbxNetworkSandboxSession({ binary: sbx.binary, sandboxId: 'box' });

    const blocked = await session.blockedRequests?.({ since: new Date('2026-10-23T15:08:17Z') });

    expect(blocked?.map(({ host }) => host)).toEqual(['www.wikipedia.org', 'api.github.com']);
  });

  it('is empty when the proxy refused nothing', async () => {
    sbx.update((state) => {
      delete state.policyLog;
    });
    const session = await createSbxNetworkSandboxSession({ binary: sbx.binary, sandboxId: 'box' });

    expect(await session.blockedRequests?.()).toEqual([]);
  });

  it('asks the log again while the Docker sign-in service is unavailable', async () => {
    sbx.update((state) => {
      state.unavailableOnce = ['policy log'];
    });
    const cli = new SbxCli(sbx.binary, false, { retryDelaysMs: [10] });

    const blocked = await blockedRequests(cli, 'other');

    expect(blocked.map(({ host }) => host)).toEqual(['neverssl.com']);
    expect(sbx.callsOf('policy')).toHaveLength(2);
  });

  it('is absent in the cloud', async () => {
    const cloud = await createSbxNetworkSandboxSession({
      binary: sbx.binary,
      sandboxId: 'box',
      cloud: true,
    });

    expect(cloud.blockedRequests).toBeUndefined();
  });
});
