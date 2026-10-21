import { describe, expect, it } from 'vitest';

import type { CatalogEntry } from './catalog.js';

import { deselect, expandSelection, explainSelection } from './selection.js';

/**
 * A plugin of two items, the second requiring the first, that requires a tool on its own; a
 * command on its own that requires that tool too.
 */
const entries: CatalogEntry[] = [
  {
    id: 'plugin:docs',
    kind: 'plugin',
    name: 'docs',
    requires: ['docs/command:ask', 'docs/mcp-server:context7', 'tool:fetch'],
  },
  {
    id: 'docs/command:ask',
    kind: 'command',
    name: 'ask',
    plugin: 'docs',
    requires: ['docs/mcp-server:context7'],
  },
  {
    id: 'docs/mcp-server:context7',
    kind: 'mcp-server',
    name: 'context7',
    plugin: 'docs',
    requires: [],
  },
  { id: 'tool:fetch', kind: 'tool', name: 'fetch', requires: [] },
  { id: 'command:get', kind: 'command', name: 'get', requires: ['tool:fetch'] },
];

describe('expandSelection', () => {
  it('adds what is required, in the order of the entries', () => {
    expect(expandSelection(entries, ['command:get', 'docs/command:ask'])).toEqual([
      'docs/command:ask',
      'docs/mcp-server:context7',
      'tool:fetch',
      'command:get',
    ]);
  });

  it('refuses an unknown id, unless told to skip it', () => {
    expect(() => expandSelection(entries, ['skill:gone'])).toThrow(
      'The catalog has no skill:gone.',
    );
    expect(expandSelection(entries, ['skill:gone', 'tool:fetch'], { ignoreUnknown: true })).toEqual(
      ['tool:fetch'],
    );
  });
});

describe('explainSelection', () => {
  it('tells what is chosen, and what brings the rest', () => {
    expect(explainSelection(entries, ['plugin:docs', 'command:get'])).toEqual([
      { id: 'plugin:docs', chosen: true, requiredBy: [] },
      { id: 'docs/command:ask', chosen: false, requiredBy: ['plugin:docs'] },
      {
        id: 'docs/mcp-server:context7',
        chosen: false,
        requiredBy: ['plugin:docs', 'docs/command:ask'],
      },
      { id: 'tool:fetch', chosen: false, requiredBy: ['plugin:docs', 'command:get'] },
      { id: 'command:get', chosen: true, requiredBy: [] },
    ]);
  });

  it('keeps an id chosen and required as both', () => {
    expect(explainSelection(entries, ['tool:fetch', 'command:get'])).toEqual([
      { id: 'tool:fetch', chosen: true, requiredBy: ['command:get'] },
      { id: 'command:get', chosen: true, requiredBy: [] },
    ]);
  });
});

describe('deselect', () => {
  it('drops a chosen id that nothing else brings', () => {
    expect(deselect(entries, ['command:get', 'docs/command:ask'], 'command:get')).toEqual({
      selection: ['docs/command:ask'],
      requiredBy: [],
      removed: ['tool:fetch', 'command:get'],
    });
  });

  it('tells what still brings an id', () => {
    expect(deselect(entries, ['tool:fetch', 'command:get'], 'tool:fetch')).toEqual({
      selection: ['command:get'],
      requiredBy: ['command:get'],
      removed: [],
    });
    expect(deselect(entries, ['docs/command:ask'], 'docs/mcp-server:context7')).toEqual({
      selection: ['docs/command:ask'],
      requiredBy: ['docs/command:ask'],
      removed: [],
    });
  });

  it('replaces a plugin chosen whole by its other items, which no longer bring its requires', () => {
    expect(deselect(entries, ['plugin:docs', 'command:get'], 'docs/command:ask')).toEqual({
      selection: ['docs/mcp-server:context7', 'command:get'],
      requiredBy: [],
      removed: ['plugin:docs', 'docs/command:ask'],
    });
    expect(deselect(entries, ['plugin:docs'], 'docs/mcp-server:context7')).toEqual({
      selection: ['docs/command:ask'],
      requiredBy: ['docs/command:ask'],
      removed: ['plugin:docs', 'tool:fetch'],
    });
  });

  it('keeps an id the catalog no longer has', () => {
    expect(deselect(entries, ['skill:gone', 'command:get'], 'command:get')).toEqual({
      selection: ['skill:gone'],
      requiredBy: [],
      removed: ['tool:fetch', 'command:get'],
    });
  });
});
