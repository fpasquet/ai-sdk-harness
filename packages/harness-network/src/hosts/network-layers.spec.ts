import { describe, expect, it } from 'vitest';

import { InvalidHostError } from '../errors/invalid-host-error.js';
import { networkLayers } from './network-layers.js';

describe('networkLayers', () => {
  const layers = networkLayers({
    locked: ['api.anthropic.com', 'registry.npmjs.org'],
    general: ['github.com', '*.githubusercontent.com', 'registry.npmjs.org'],
    sources: {
      'acme/widgets': ['pypi.org', 'files.pythonhosted.org', 'GitHub.com'],
      'acme/infra': ['registry.terraform.io'],
    },
  });

  it('merges the hosts of every layer as a network policy takes them', () => {
    expect(layers.allowedHosts).toEqual([
      '*.githubusercontent.com',
      'api.anthropic.com',
      'files.pythonhosted.org',
      'github.com',
      'pypi.org',
      'registry.npmjs.org',
      'registry.terraform.io',
    ]);
  });

  it('tells which layers allow a host, the locked hosts first, then the general list, then the sources', () => {
    expect(layers.originOf('registry.npmjs.org')).toEqual([
      { layer: 'locked' },
      { layer: 'general' },
    ]);
    expect(layers.originOf('github.com')).toEqual([
      { layer: 'general' },
      { layer: 'source', source: 'acme/widgets' },
    ]);
    expect(layers.originOf('registry.terraform.io')).toEqual([
      { layer: 'source', source: 'acme/infra' },
    ]);
  });

  it('finds the layer of a name its wildcard covers, and of the wildcard itself', () => {
    expect(layers.originOf('raw.githubusercontent.com')).toEqual([{ layer: 'general' }]);
    expect(layers.originOf('*.githubusercontent.com')).toEqual([{ layer: 'general' }]);
    expect(layers.originOf('API.Anthropic.com.')).toEqual([{ layer: 'locked' }]);
  });

  it('gives no origin for a host no layer allows', () => {
    expect(layers.originOf('example.com')).toEqual([]);
    expect(layers.originOf('githubusercontent.com')).toEqual([]);
  });

  it('hands out origins a caller may change without changing the layers', () => {
    const [origin] = layers.originOf('pypi.org');
    if (origin?.layer === 'source') origin.source = 'changed';
    expect(layers.originOf('pypi.org')).toEqual([{ layer: 'source', source: 'acme/widgets' }]);
  });

  it('matches the domain of a wildcard itself when told to', () => {
    const covering = networkLayers({
      general: ['*.githubusercontent.com'],
      wildcardMatchesDomain: true,
    });
    expect(covering.originOf('githubusercontent.com')).toEqual([{ layer: 'general' }]);
  });

  it('takes any layer left out', () => {
    expect(networkLayers({}).allowedHosts).toEqual([]);
    expect(networkLayers({ sources: { only: ['pypi.org'] } }).originOf('pypi.org')).toEqual([
      { layer: 'source', source: 'only' },
    ]);
  });

  it('refuses a host a network policy cannot take, in any layer', () => {
    expect(() => networkLayers({ general: ['*'] })).toThrow(InvalidHostError);
    expect(() => networkLayers({ sources: { repo: ['https://github.com'] } })).toThrow(
      '"https://github.com" is not a host',
    );
  });
});
