import { describe, expect, it } from 'vitest';

import { InvalidHostError } from '../errors/invalid-host-error.js';
import { allowedHosts, isAllowedHost, networkPolicy } from './allowed-hosts.js';

describe('isAllowedHost', () => {
  it.each([
    'github.com',
    'API.GitHub.com',
    'localhost',
    'my-host.example.co.uk',
    '*.githubusercontent.com',
    '*.example.co.uk',
  ])('takes %s', (host) => {
    expect(isAllowedHost(host)).toBe(true);
  });

  it.each([
    '',
    '*',
    '*.com',
    '**.example.com',
    'api.*.example.com',
    'https://github.com',
    'github.com/fpasquet',
    'github.com:443',
    '-github.com',
    'github-.com',
    'git hub.com',
    `${'a'.repeat(250)}.com`,
  ])('refuses %j', (host) => {
    expect(isAllowedHost(host)).toBe(false);
  });
});

describe('isAllowedHost with publicDomain', () => {
  it.each([
    'github.com',
    'API.GitHub.com',
    '*.githubusercontent.com',
    'example.co.uk',
    'xn--bcher-kva.example',
    'example.xn--p1ai',
  ])('takes %s', (host) => {
    expect(isAllowedHost(host, { publicDomain: true })).toBe(true);
  });

  it.each([
    'localhost',
    'intranet',
    '10.0.0.1',
    '192.168.1.20',
    '169.254.169.254',
    'example.123',
    'host.local1',
    'example.c',
    '*.com',
    'https://github.com',
  ])('refuses %j', (host) => {
    expect(isAllowedHost(host, { publicDomain: true })).toBe(false);
  });

  it('takes them all without it', () => {
    expect(isAllowedHost('localhost')).toBe(true);
    expect(isAllowedHost('10.0.0.1')).toBe(true);
  });
});

describe('allowedHosts', () => {
  it('merges lists in lower case, each host once, sorted', () => {
    expect(
      allowedHosts(
        ['registry.npmjs.org', 'API.github.com'],
        [],
        ['api.github.com', '*.example.dev'],
      ),
    ).toEqual(['*.example.dev', 'api.github.com', 'registry.npmjs.org']);
    expect(allowedHosts()).toEqual([]);
  });

  it('refuses a host a network policy cannot take, naming it', () => {
    expect(() => allowedHosts(['github.com'], ['*'])).toThrow(InvalidHostError);
    expect(() => allowedHosts(['https://api.github.com'])).toThrow(
      '"https://api.github.com" is not a host',
    );
  });
});

describe('networkPolicy', () => {
  it('lets the sandbox reach the hosts of its lists and nothing else', () => {
    expect(networkPolicy(['pypi.org'], ['api.anthropic.com', 'pypi.org'])).toEqual({
      mode: 'custom',
      allowedHosts: ['api.anthropic.com', 'pypi.org'],
    });
  });
});
