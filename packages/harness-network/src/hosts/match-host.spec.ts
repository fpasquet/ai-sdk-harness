import { describe, expect, it } from 'vitest';

import { matchesHost } from './match-host.js';

describe('matchesHost', () => {
  const hosts = ['github.com', '*.githubusercontent.com', 'Registry.npmjs.org'];

  it.each([
    'github.com',
    'GitHub.com',
    'github.com.',
    'raw.githubusercontent.com',
    'a.b.githubusercontent.com',
    '*.raw.githubusercontent.com',
    'registry.npmjs.org',
  ])('matches %s', (host) => {
    expect(matchesHost(hosts, host)).toBe(true);
  });

  it.each([
    'githubusercontent.com',
    'api.github.com',
    'evilgithub.com',
    'github.com.evil.dev',
    'xgithubusercontent.com',
    '.githubusercontent.com',
    '',
  ])('does not match %j', (host) => {
    expect(matchesHost(hosts, host)).toBe(false);
  });

  it('matches the domain of a wildcard itself only when told to', () => {
    const options = { wildcardMatchesDomain: true };
    expect(matchesHost(hosts, 'githubusercontent.com', options)).toBe(true);
    expect(matchesHost(hosts, 'GitHubUserContent.com.', options)).toBe(true);
    expect(matchesHost(hosts, 'xgithubusercontent.com', options)).toBe(false);
    expect(matchesHost(hosts, 'api.github.com', options)).toBe(false);
  });

  it('matches nothing with no host', () => {
    expect(matchesHost([], 'github.com')).toBe(false);
  });
});
