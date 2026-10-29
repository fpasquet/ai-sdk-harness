import { describe, expect, it, vi } from 'vitest';

import { silentLogger } from '../common/logger.js';
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

  it('lists its sandboxes, and forgets one only by the registration it listed', () => {
    const registry = new SandboxRegistry();
    registry.register('box', registration('::ffff:10.0.0.3'));
    const [listed] = registry.list();

    registry.register('box', registration('10.0.0.3'));
    registry.remove('box', listed?.serial);

    expect(listed).toMatchObject({ name: 'box', address: '10.0.0.3', serial: 1 });
    expect(registry.list()).toEqual([
      { name: 'box', address: '10.0.0.3', serial: 2, sent: 0, received: 0 },
    ]);
    registry.remove('box', 2);
    expect(registry.list()).toEqual([]);
  });

  it('tells the bytes a sandbox moved once it forgets it', () => {
    const info = vi.fn();
    const registry = new SandboxRegistry(false, { ...silentLogger, info });
    registry.register('box', registration('10.0.0.3'));

    registry.remove('box');
    registry.remove('box');

    expect(info).toHaveBeenCalledExactlyOnceWith(
      'box forgotten, having sent 0 B out and received 0 B',
    );
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
});
