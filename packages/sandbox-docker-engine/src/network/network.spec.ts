import { HarnessCapabilityUnsupportedError } from '@ai-sdk/harness';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DockerCli } from '../transport/docker-cli.js';

import { BLOCKED_FILE, blockedRequests } from './blocked-requests.js';
import { egressPolicyOf, POLICY_FILE, writeNetworkPolicy } from './network-policy.js';
import { endpointUrl, forwardsOf, publishedUrl } from './port-forwards.js';

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'docker-engine-network-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('the network policy', () => {
  it('becomes the policy the proxy reads', () => {
    expect(egressPolicyOf({ mode: 'allow-all' })).toEqual({ mode: 'allow-all' });
    expect(egressPolicyOf({ mode: 'deny-all' })).toEqual({ mode: 'deny-all' });
    expect(egressPolicyOf({ mode: 'custom', allowedHosts: ['example.com'] })).toEqual({
      mode: 'custom',
      allowedHosts: ['example.com'],
    });
  });

  it('refuses CIDRs, which the proxy cannot enforce', () => {
    expect(() => egressPolicyOf({ mode: 'custom', allowedCIDRs: ['10.0.0.0/8'] })).toThrow(
      HarnessCapabilityUnsupportedError,
    );
  });

  it('is written at once, nothing left beside it', async () => {
    await writeNetworkPolicy(directory, { mode: 'custom', allowedHosts: ['example.com'] });
    await writeNetworkPolicy(directory, { mode: 'deny-all' });

    expect(JSON.parse(await readFile(join(directory, POLICY_FILE), 'utf8'))).toEqual({
      mode: 'deny-all',
    });
    expect(await readdir(directory)).toEqual([POLICY_FILE]);
  });
});

describe('blockedRequests', () => {
  it('reads what the proxy refused, the last refused first, since a time when asked', async () => {
    await writeFile(
      join(directory, BLOCKED_FILE),
      [
        '{"host":"a.test","port":443,"at":"2026-11-18T10:00:00.000Z","reason":"policy"}',
        'not json',
        '{"host":"b.test","at":"not a date","reason":"policy"}',
        '{"host":"c.test","at":"2026-11-18T10:00:00.000Z","reason":"unknown"}',
        '{"host":"169.254.169.254","port":80,"at":"2026-11-18T11:00:00.000Z","reason":"private-address"}',
        '',
      ].join('\n'),
    );

    expect(await blockedRequests(directory)).toEqual([
      {
        host: '169.254.169.254',
        port: 80,
        at: new Date('2026-11-18T11:00:00.000Z'),
        reason: 'private-address',
      },
      { host: 'a.test', port: 443, at: new Date('2026-11-18T10:00:00.000Z'), reason: 'policy' },
    ]);
    expect(
      await blockedRequests(directory, { since: new Date('2026-11-18T10:30:00.000Z') }),
    ).toHaveLength(1);
  });

  it('lists none without a log', async () => {
    expect(await blockedRequests(directory)).toEqual([]);
  });
});

describe('the ports of the sandbox', () => {
  it('are each forwarded from a port of the proxy', () => {
    expect(forwardsOf([8080, 4000])).toEqual([
      { listen: 40_000, host: 'sandbox', port: 8080 },
      { listen: 40_001, host: 'sandbox', port: 4000 },
    ]);
  });

  it('are reached on the loopback port Docker published', async () => {
    const asked: string[][] = [];
    const cli = {
      check: (args: string[]) => {
        asked.push(args);
        return Promise.resolve('0.0.0.0:1\n127.0.0.1:49153\n[::1]:49153\n');
      },
    } as unknown as DockerCli;

    expect(await publishedUrl(cli, 'box-egress', 40_000)).toBe('http://127.0.0.1:49153');
    expect(asked).toEqual([['port', 'box-egress', '40000/tcp']]);
    const none = { check: () => Promise.resolve('[::1]:49153\n') } as unknown as DockerCli;
    await expect(publishedUrl(none, 'box-egress', 40_000)).rejects.toThrow(/no loopback port/);
  });

  it('take the protocol asked for', () => {
    expect(endpointUrl('http://127.0.0.1:1', 'ws')).toBe('ws://127.0.0.1:1');
    expect(endpointUrl('http://127.0.0.1:1', 'https')).toBe('https://127.0.0.1:1');
    expect(endpointUrl('http://127.0.0.1:1', 'http')).toBe('http://127.0.0.1:1');
  });
});
