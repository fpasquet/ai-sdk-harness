import { tool } from '@ai-sdk/provider-utils';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { Plugin } from '../definitions/plugin.js';

import { launcherRegistries, pluginHosts } from './plugin-hosts.js';

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
      server: ['api.github.com', 'api.search.dev', 'localhost', 'registry.npmjs.org'],
    });
  });

  it('gives the registry a stdio MCP server downloads its package from, where it starts', () => {
    expect(
      pluginHosts([
        {
          name: 'tools',
          description: '',
          mcpServers: {
            memory: { type: 'stdio', command: 'npx', args: ['-y', 'memory-mcp'], runIn: 'sandbox' },
            time: { type: 'stdio', command: 'uvx', args: ['mcp-server-time'] },
            local: { type: 'stdio', command: 'node', args: ['server.js'], runIn: 'sandbox' },
          },
        },
      ]),
    ).toEqual({
      sandbox: ['registry.npmjs.org'],
      server: ['files.pythonhosted.org', 'pypi.org'],
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
      of({ mcpServers: { docs: { type: 'stdio', command: 'docs-mcp', runIn: 'sandbox' } } }),
    ).toEqual(inSandbox);
    expect(of({ mcpServers: { docs: { type: 'stdio', command: 'docs-mcp' } } })).toEqual(onServer);
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

describe('launcherRegistries', () => {
  it.each([
    ['npx', ['-y', 'pkg'], ['registry.npmjs.org']],
    ['/usr/local/bin/npx', [], ['registry.npmjs.org']],
    ['C:\\Program Files\\nodejs\\npx.cmd', [], ['registry.npmjs.org']],
    ['pnpx', [], ['registry.npmjs.org']],
    ['bunx', [], ['registry.npmjs.org']],
    ['pnpm', ['dlx', 'pkg'], ['registry.npmjs.org']],
    ['npm', ['exec', 'pkg'], ['registry.npmjs.org']],
    ['bun', ['x', 'pkg'], ['registry.npmjs.org']],
    ['yarn', ['dlx', 'pkg'], ['registry.yarnpkg.com']],
    ['uvx', ['pkg'], ['pypi.org', 'files.pythonhosted.org']],
    ['uv', ['tool', 'run', 'pkg'], ['pypi.org', 'files.pythonhosted.org']],
    ['pipx', ['run', 'pkg'], ['pypi.org', 'files.pythonhosted.org']],
  ])('%s %j downloads from %j', (command, args, registries) => {
    expect(launcherRegistries(command, args)).toEqual(registries);
  });

  it.each([
    ['node', ['server.js']],
    ['pnpm', ['exec', 'tsx', 'server.ts']],
    ['npm', ['run', 'mcp']],
    ['python', ['-m', 'server']],
    ['', []],
  ])('%s %j downloads nothing', (command, args) => {
    expect(launcherRegistries(command, args)).toEqual([]);
  });
});
