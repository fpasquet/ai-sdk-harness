import { tool } from '@ai-sdk/provider-utils';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { mcpToolsPlugin } from './mcp-tools-plugin.js';

const echo = tool({ description: 'Echo', inputSchema: z.object({}), execute: () => 'echo' });
const client = { tools: () => Promise.resolve({ search: echo, 'get.item': echo }) };

describe('mcpToolsPlugin', () => {
  it('makes a plugin of the server tools, prefixed with a name a model can call', async () => {
    const plugin = await mcpToolsPlugin({
      name: 'tracker',
      description: 'Tracker.',
      version: '1',
      client,
    });
    expect(plugin).toEqual({
      name: 'tracker',
      description: 'Tracker.',
      version: '1',
      tools: { tracker_search: echo, tracker_get_item: echo },
    });
  });

  it('keeps only the allowed tools, under the prefix given', async () => {
    const plugin = await mcpToolsPlugin({
      name: 'tracker',
      description: '',
      client,
      allowedTools: ['search'],
      prefix: '',
    });
    expect(Object.keys(plugin.tools ?? {})).toEqual(['search']);
  });

  it('refuses an allowed tool the server does not have', async () => {
    await expect(
      mcpToolsPlugin({
        name: 'tracker',
        description: '',
        client,
        allowedTools: ['search', 'delete'],
      }),
    ).rejects.toThrow('Plugin "tracker": its MCP server has no tool delete.');
  });
});
