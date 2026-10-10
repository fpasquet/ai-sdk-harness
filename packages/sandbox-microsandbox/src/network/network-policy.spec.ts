import { describe, expect, it } from 'vitest';

import { toNetworkPolicy } from './network-policy.js';

describe('toNetworkPolicy', () => {
  it('maps the presets, ingress allowed so the published ports stay reachable', () => {
    expect(toNetworkPolicy({ mode: 'allow-all' })).toEqual({
      defaultEgress: 'allow',
      defaultIngress: 'allow',
      rules: [],
    });
    expect(toNetworkPolicy({ mode: 'deny-all' })).toEqual({
      defaultEgress: 'deny',
      defaultIngress: 'allow',
      rules: [],
    });
  });

  it('allows the listed hosts and blocks, denied blocks first', () => {
    const policy = toNetworkPolicy({
      mode: 'custom',
      allowedHosts: ['api.anthropic.com', '*.npmjs.org'],
      allowedCIDRs: ['203.0.113.0/24'],
      deniedCIDRs: ['169.254.169.254/32'],
    });

    expect(policy.defaultEgress).toBe('deny');
    expect(policy.rules.map(({ action, destination }) => [action, destination])).toEqual([
      ['deny', { kind: 'cidr', cidr: '169.254.169.254/32' }],
      ['allow', { kind: 'domain', domain: 'api.anthropic.com' }],
      ['allow', { kind: 'domainSuffix', suffix: '.npmjs.org' }],
      ['allow', { kind: 'cidr', cidr: '203.0.113.0/24' }],
    ]);
    expect(policy.rules.every(({ direction }) => direction === 'egress')).toBe(true);
  });

  it('allows the blocks alone when no host is listed', () => {
    const policy = toNetworkPolicy({ mode: 'custom', allowedCIDRs: ['10.1.0.0/16'] });

    expect(policy.rules).toHaveLength(1);
  });
});
