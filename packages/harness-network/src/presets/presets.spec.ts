import { describe, expect, it } from 'vitest';

import { harnessHosts } from './harness-hosts.js';
import { TRUSTED_HOSTS, trustedHosts } from './trusted-hosts.js';

describe('trustedHosts', () => {
  it('gives the hosts of the services named, each once', () => {
    expect(trustedHosts('npm', 'pypi', 'npm')).toEqual([
      'registry.npmjs.org',
      'pypi.org',
      'files.pythonhosted.org',
    ]);
  });

  it('gives every service without any', () => {
    expect(trustedHosts()).toEqual(Object.values(TRUSTED_HOSTS).flat());
  });

  it('gives a new list each time', () => {
    trustedHosts('github').push('example.com');
    expect(trustedHosts('github')).not.toContain('example.com');
  });

  it('names the domain of each wildcard of GitHub it relies on', () => {
    expect(TRUSTED_HOSTS.github).toEqual(
      expect.arrayContaining(['github.com', 'api.github.com', 'codeload.github.com']),
    );
  });
});

describe('harnessHosts', () => {
  it('gives the hosts of Claude Code and Codex', () => {
    expect(harnessHosts('claude-code')).toEqual(['api.anthropic.com']);
    expect(harnessHosts('codex')).toEqual(['api.openai.com', 'auth.openai.com', 'chatgpt.com']);
  });

  it('gives none for a harness it does not know', () => {
    expect(harnessHosts('opencode')).toEqual([]);
    expect(harnessHosts('constructor')).toEqual([]);
  });
});
