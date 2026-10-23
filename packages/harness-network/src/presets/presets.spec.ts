import { describe, expect, it } from 'vitest';

import { HARNESS_NETWORK, harnessHosts } from './harness-hosts.js';
import { PROVIDER_HOSTS, providerHosts } from './provider-hosts.js';
import { TRUSTED_GROUPS, TRUSTED_HOSTS, trustedHosts } from './trusted-hosts.js';

describe('trustedHosts', () => {
  it('gives the hosts of the services named, each once', () => {
    expect(trustedHosts('npm', 'pypi', 'npm')).toEqual([
      'registry.npmjs.org',
      'pypi.org',
      'files.pythonhosted.org',
    ]);
  });

  it('gives the services of a group', () => {
    expect(trustedHosts('rust')).toEqual([
      'crates.io',
      'index.crates.io',
      'static.crates.io',
      'sh.rustup.rs',
      'static.rust-lang.org',
    ]);
    expect(trustedHosts('jvm', 'go')).toContain('dl.google.com');
  });

  it('gives every service without any, each host once', () => {
    const all = trustedHosts();
    expect(all).toEqual([...new Set(Object.values(TRUSTED_HOSTS).flat())]);
    expect(all).toContain('storage.googleapis.com');
  });

  it('gives a new list each time', () => {
    trustedHosts('github').push('example.com');
    expect(trustedHosts('github')).not.toContain('example.com');
  });

  it('groups only services it knows, and no service twice', () => {
    const grouped = Object.values(TRUSTED_GROUPS).flat();
    expect(grouped.filter((service) => !Object.hasOwn(TRUSTED_HOSTS, service))).toEqual([]);
    expect(new Set(grouped).size).toBe(grouped.length);
    for (const group of Object.keys(TRUSTED_GROUPS)) {
      expect(Object.hasOwn(TRUSTED_HOSTS, group)).toBe(false);
    }
  });
});

describe('providerHosts', () => {
  it('gives the API host of a provider', () => {
    expect(providerHosts('google')).toEqual(['generativelanguage.googleapis.com']);
    expect(providerHosts('openrouter')).toEqual(['openrouter.ai']);
    expect(providerHosts('gateway')).toEqual(['ai-gateway.vercel.sh']);
  });

  it('gives Vertex AI by region, global by default, and its token host', () => {
    expect(providerHosts('google-vertex')).toEqual([
      'aiplatform.googleapis.com',
      'oauth2.googleapis.com',
    ]);
    expect(providerHosts('google-vertex', { region: 'europe-west1' })).toEqual([
      'europe-west1-aiplatform.googleapis.com',
      'oauth2.googleapis.com',
    ]);
    expect(providerHosts('google-vertex', { region: 'eu' })[0]).toBe(
      'aiplatform.eu.rep.googleapis.com',
    );
  });

  it('gives Bedrock in its region, which it requires', () => {
    expect(providerHosts('amazon-bedrock', { region: 'us-east-1' })).toEqual([
      'bedrock-runtime.us-east-1.amazonaws.com',
    ]);
    expect(() => providerHosts('amazon-bedrock')).toThrow('needs the region');
  });

  it('gives Azure for one resource, or any', () => {
    expect(providerHosts('azure', { resource: 'acme' })).toEqual([
      'acme.openai.azure.com',
      'acme.services.ai.azure.com',
    ]);
    expect(providerHosts('azure')).toEqual(['*.openai.azure.com', '*.services.ai.azure.com']);
  });

  it('refuses a region or a resource no host can carry', () => {
    expect(() => providerHosts('google-vertex', { region: 'evil.com/x' })).toThrow(
      'is not a name a host can carry',
    );
    expect(() => providerHosts('azure', { resource: '*' })).toThrow();
  });

  it('gives none for a provider it does not know', () => {
    expect(providerHosts('acme')).toEqual([]);
    expect(providerHosts('constructor')).toEqual([]);
  });

  it('holds the default host of each provider package', () => {
    expect(PROVIDER_HOSTS.anthropic).toEqual(['api.anthropic.com']);
    expect(PROVIDER_HOSTS.openai).toEqual(['api.openai.com']);
  });
});

describe('harnessHosts', () => {
  it('gives where a harness installs, its service and its own provider', () => {
    expect(harnessHosts('claude-code')).toEqual(['registry.npmjs.org', 'api.anthropic.com']);
    expect(harnessHosts('codex')).toEqual(['registry.npmjs.org', 'api.openai.com', 'chatgpt.com']);
    expect(harnessHosts('github-copilot')).toEqual([
      'registry.npmjs.org',
      'github.com',
      'api.github.com',
      'api.githubcopilot.com',
      '*.githubcopilot.com',
    ]);
  });

  it('takes another provider in place of its own', () => {
    expect(harnessHosts('claude-code', { provider: 'gateway' })).toEqual([
      'registry.npmjs.org',
      'ai-gateway.vercel.sh',
    ]);
    expect(
      harnessHosts('claude-code', { provider: 'amazon-bedrock', region: 'eu-west-3' }),
    ).toEqual(['registry.npmjs.org', 'bedrock-runtime.eu-west-3.amazonaws.com']);
    expect(harnessHosts('opencode', { provider: 'google' })).toEqual([
      'registry.npmjs.org',
      'generativelanguage.googleapis.com',
    ]);
  });

  it('leaves out its optional hosts, and its install hosts on request', () => {
    expect(harnessHosts('claude-code', { optional: true })).toContain(
      'http-intake.logs.us5.datadoghq.com',
    );
    expect(harnessHosts('claude-code', { install: false })).toEqual(['api.anthropic.com']);
  });

  it('gives none for a harness that runs on your server, or one it does not know', () => {
    expect(harnessHosts('cline')).toEqual([]);
    expect(harnessHosts('opencode-next')).toEqual([]);
    expect(harnessHosts('constructor')).toEqual([]);
  });

  it('knows the providers each harness names', () => {
    const providers = Object.values(HARNESS_NETWORK).flatMap(({ providers }) => providers);
    expect(providers.filter((provider) => providerHosts(provider).length === 0)).toEqual([]);
  });
});
