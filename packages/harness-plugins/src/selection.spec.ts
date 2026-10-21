import { describe, expect, it } from 'vitest';

import { createCatalog } from './catalog/catalog.js';
import { entriesOfDescription } from './catalog/selection.js';
import { deselect, expand, explain } from './selection.js';

/**
 * A plugin with no item, one whose command requires its skill and a tool on its own, one that
 * requires the second whole; a tool and a command on their own.
 */
const catalog = createCatalog({
  plugins: [
    { name: 'bare', description: 'Nothing.' },
    {
      name: 'docs',
      description: 'Docs.',
      skills: [{ name: 'read', description: 'Reads.', content: 'Read.' }],
      commands: [
        {
          name: 'ask',
          description: 'Asks.',
          prompt: 'Ask.',
          requires: ['skill:read', 'tool:fetch'],
        },
      ],
    },
    {
      name: 'kit',
      description: 'Kit.',
      rules: [{ name: 'style', description: 'Style.', content: 'Style.' }],
      requires: ['plugin:docs'],
    },
  ],
  items: [
    {
      kind: 'tool',
      name: 'fetch',
      type: 'http',
      description: 'Fetches.',
      url: 'https://example.com',
    },
    {
      kind: 'command',
      name: 'get',
      description: 'Gets.',
      prompt: 'Get.',
      requires: ['tool:fetch'],
    },
  ],
});
const ids = catalog.entries().map(({ id }) => id);

describe('ai-sdk-harness-plugins/selection', () => {
  it('reads from the description the entries of the catalog, in its order', async () => {
    const description = await catalog.describe();
    expect(entriesOfDescription(description)).toEqual(catalog.entries());
  });

  it("gives the catalog's answers for every id", async () => {
    const description = await catalog.describe();
    for (const id of ids) {
      expect(expand(description, [id])).toEqual(catalog.expand([id]));
      expect(explain(description, [id, 'command:get'])).toEqual(
        catalog.explain([id, 'command:get']),
      );
      expect(deselect(description, ['plugin:kit', 'command:get'], id)).toEqual(
        catalog.deselect(['plugin:kit', 'command:get'], id),
      );
    }
  });

  it('skips an id the description does not have, when told to', async () => {
    const description = await catalog.describe();
    expect(() => expand(description, ['skill:gone'])).toThrow('The catalog has no skill:gone.');
    expect(expand(description, ['skill:gone', 'command:get'], { ignoreUnknown: true })).toEqual([
      'tool:fetch',
      'command:get',
    ]);
  });
});
