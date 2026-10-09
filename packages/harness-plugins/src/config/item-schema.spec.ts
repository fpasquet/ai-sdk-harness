import { describe, expect, it } from 'vitest';

import { pluginOfItem } from './item-schema.js';

describe('pluginOfItem', () => {
  it('names the plugin of an item after its kind and its name, as a slug', () => {
    const plugin = (kind: 'mcp-server' | 'tool', name: string) =>
      pluginOfItem(
        kind === 'tool'
          ? { kind, name, type: 'registered', ref: 'x' }
          : { kind, name, type: 'http', url: 'https://mcp.example.com' },
      ).name;
    expect(plugin('tool', 'npm-latest')).toBe('tool-npm-latest');
    expect(plugin('tool', '_search_Docs_')).toBe('tool-search-docs');
    expect(plugin('mcp-server', 'Linear')).toBe('mcp-server-linear');
  });

  it('names it in linear time, whatever the name', () => {
    const name = `${'-'.repeat(100_000)}x${'-'.repeat(100_000)}`;
    const started = performance.now();
    expect(pluginOfItem({ kind: 'tool', name, type: 'registered', ref: 'x' }).name).toBe('tool-x');
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
