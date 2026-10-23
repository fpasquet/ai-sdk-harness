import { tool } from '@ai-sdk/provider-utils';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { pluginHosts } from './plugin-hosts.js';

describe('pluginHosts', () => {
  it('reads the host of each http tool and MCP server, and adds the declared ones', () => {
    expect(
      pluginHosts([
        {
          name: 'github',
          description: '',
          tools: {
            issue: {
              type: 'http',
              description: 'An issue',
              url: 'https://API.github.com:8443/repos/{owner}/{repo}/issues/{number}?state={state}',
            },
            count: { type: 'sandbox-command', description: 'Count', command: 'wc -l' },
            create: { type: 'registered', ref: 'issues.create' },
            code: tool({ inputSchema: z.object({}), execute: () => 'https://code.example.com' }),
          },
          mcpServers: {
            remote: { type: 'http', url: 'https://mcp.github.com/mcp', runIn: 'sandbox' },
            search: { type: 'stdio', command: 'npx', args: ['-y', 'search-mcp'] },
          },
          network: { hosts: ['*.githubusercontent.com', 'api.github.com'] },
        },
        {
          name: 'docs',
          description: '',
          mcpServers: { docs: { type: 'http', url: 'http://localhost:3001/mcp' } },
          network: { hosts: ['API.search.dev'] },
        },
        { name: 'none', description: '' },
      ]),
    ).toEqual([
      '*.githubusercontent.com',
      'api.github.com',
      'api.search.dev',
      'localhost',
      'mcp.github.com',
    ]);
  });

  it('gives none for plugins that reach nothing', () => {
    expect(pluginHosts([])).toEqual([]);
    expect(
      pluginHosts([
        { name: 'kit', description: '', skills: [{ name: 's', description: '', content: 'c' }] },
      ]),
    ).toEqual([]);
  });
});
