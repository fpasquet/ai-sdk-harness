import { tool } from '@ai-sdk/provider-utils';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { Plugin } from '../definitions/plugin.js';

import { pluginHosts } from './plugin-hosts.js';

describe('pluginHosts', () => {
  it('reads the hosts of http tools and MCP servers, and the declared ones, by where they are reached', () => {
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
    ).toEqual({
      sandbox: ['*.githubusercontent.com', 'api.github.com', 'mcp.github.com'],
      server: ['api.github.com', 'api.search.dev', 'localhost'],
    });
  });

  it('gives declared hosts to the sandbox when any part of the plugin runs there', () => {
    const hosts = { hosts: ['api.acme.dev'] };
    const of = (plugin: Omit<Plugin, 'description' | 'name'>) =>
      pluginHosts([{ name: 'acme', description: '', ...plugin, network: hosts }]);
    const inSandbox = { sandbox: ['api.acme.dev'], server: [] };
    const onServer = { sandbox: [], server: ['api.acme.dev'] };
    expect(of({})).toEqual(inSandbox);
    expect(of({ hooks: [{ event: 'Stop', command: 'curl https://api.acme.dev' }] })).toEqual(
      inSandbox,
    );
    expect(of({ files: [{ path: 'a.sh', content: '' }] })).toEqual(inSandbox);
    expect(
      of({ tools: { count: { type: 'sandbox-command', description: 'd', command: 'wc' } } }),
    ).toEqual(inSandbox);
    expect(
      of({ mcpServers: { docs: { type: 'stdio', command: 'npx', runIn: 'sandbox' } } }),
    ).toEqual(inSandbox);
    expect(of({ mcpServers: { docs: { type: 'stdio', command: 'npx' } } })).toEqual(onServer);
    expect(
      of({
        tools: {
          create: { type: 'registered', ref: 'tickets.create' },
          code: tool({ inputSchema: z.object({}), execute: () => 'done' }),
        },
      }),
    ).toEqual(onServer);
  });

  it('gives none for plugins that reach nothing', () => {
    expect(pluginHosts([])).toEqual({ sandbox: [], server: [] });
    expect(
      pluginHosts([
        { name: 'kit', description: '', skills: [{ name: 's', description: '', content: 'c' }] },
      ]),
    ).toEqual({ sandbox: [], server: [] });
  });
});
