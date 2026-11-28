import { describe, expect, it } from 'vitest';

import { SandboxRegistry } from './registry.js';

const registration = (address: string) => ({ address, allowedHosts: ['github.com'], baseUrls: {} });

describe('the registry of the egress proxy', () => {
  it('knows a sandbox by the address of its machine, dual-stack notation included', () => {
    const registry = new SandboxRegistry();
    registry.register('box', registration('10.0.0.3'));

    expect(registry.policyFor('::ffff:10.0.0.3')?.allowedHosts).toEqual(['github.com']);
    expect(registry.policyFor('10.0.0.4')).toBeUndefined();
    expect(registry.policyFor(undefined)).toBeUndefined();
  });

  it('keeps the credentials of a sandbox registered again on a new address', () => {
    const registry = new SandboxRegistry();
    const secret = 'Bearer a-real-credential-value';
    registry.register('box', registration('10.0.0.3'));
    registry.addTransformations('box', [
      { match: { host: 'api.anthropic.com' }, transform: { headers: { authorization: secret } } },
    ]);

    registry.register('box', registration('10.0.0.9'));

    expect(registry.policyFor('10.0.0.3')).toBeUndefined();
    expect(registry.policyFor('10.0.0.9')?.transformations).toHaveLength(1);
    expect(registry.holdsSecret('box', ['echo a-real-credential-value'])).toBe(true);
  });

  it('leaves an address to the sandbox that took it over', () => {
    const registry = new SandboxRegistry();
    registry.register('one', registration('10.0.0.3'));
    registry.register('two', registration('10.0.0.3'));

    registry.remove('one');
    registry.remove('one');

    expect(registry.policyFor('10.0.0.3')).toBeDefined();
    expect(() => registry.setAllowedHosts('one', [])).toThrow('knows no sandbox "one"');
  });

  it('never takes a short value for a secret', () => {
    const registry = new SandboxRegistry();
    registry.register('box', registration('10.0.0.3'));
    registry.setTransformations('box', [
      {
        match: { host: 'api.example.com' },
        transform: { headers: { authorization: 'Bearer abc' } },
      },
    ]);

    expect(registry.holdsSecret('box', ['abc'])).toBe(false);
  });

  it('replaces a credential added again for the same match, rather than piling it up', () => {
    const registry = new SandboxRegistry();
    registry.register('box', registration('10.0.0.3'));
    const rule = (token: string) => ({
      match: {
        host: 'github.com',
        path: { exact: '/acme/api.git/git-upload-pack' },
        method: ['POST'],
        headers: [{ key: { exact: 'Authorization' }, value: { exact: 'Basic placeholder-value' } }],
      },
      transform: { headers: { Authorization: `Basic ${token}` } },
    });

    registry.addTransformations('box', [rule('first-token-value')]);
    registry.addTransformations('box', [rule('renewed-token-value')]);

    expect(registry.policyFor('10.0.0.3')?.transformations).toEqual([rule('renewed-token-value')]);
    expect(registry.holdsSecret('box', ['first-token-value'])).toBe(false);
  });
});
