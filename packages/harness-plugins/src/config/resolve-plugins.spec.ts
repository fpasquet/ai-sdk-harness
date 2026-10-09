import { createMCPClient } from '@ai-sdk/mcp';
import { Experimental_StdioMCPTransport as StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio';
import { tool } from '@ai-sdk/provider-utils';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { ResolvedMcpServer } from '../definitions/plugin.js';
import type { HostMcpClient } from './resolve-plugins.js';

import { createHostSandbox } from '../../test/host-sandbox.js';
import { resolvePlugins } from './resolve-plugins.js';
import { environmentOf } from './sandbox-command-tool.js';

const SERVER = join(import.meta.dirname, '../../test/fixtures/mcp-server.mjs');

/** Runs the tool `name` of `tools` as the harness would, in `sandbox`. */
async function call(
  tools: Record<string, unknown> | undefined,
  name: string,
  input: unknown,
  sandbox?: unknown,
): Promise<unknown> {
  const tool = tools?.[name] as undefined | { execute?: unknown };
  const execute = tool?.execute as (input: unknown, options: object) => Promise<unknown>;
  return execute(input, { toolCallId: '1', messages: [], experimental_sandbox: sandbox });
}

const connect = (server: ResolvedMcpServer): Promise<HostMcpClient> =>
  createMCPClient({
    transport:
      server.type === 'stdio'
        ? new StdioMCPTransport(server)
        : { type: 'http', url: server.url, headers: server.headers },
  });

describe('resolvePlugins', () => {
  it('runs a sandbox-command tool in the sandbox, its input in the environment only', async () => {
    const sandbox = await createHostSandbox();
    const { plugins } = await resolvePlugins([
      {
        name: 'shell',
        description: '',
        tools: {
          greet: {
            type: 'sandbox-command',
            description: 'Greet',
            inputSchema: {
              type: 'object',
              properties: { who: { type: 'string' }, times: { type: 'number' } },
            },
            command: 'printf "hello %s x%s" "$INPUT_WHO" "$INPUT_TIMES"; echo "$INPUT" >&2',
          },
          fail: { type: 'sandbox-command', description: 'Fail', command: 'echo no >&2; exit 3' },
        },
      },
    ]);
    const tools = plugins[0]?.tools;
    expect(await call(tools, 'greet', { who: '$(rm -rf /)', times: 2 }, sandbox.session)).toEqual({
      exitCode: 0,
      stdout: 'hello $(rm -rf /) x2',
      stderr: '{"who":"$(rm -rf /)","times":2}\n',
    });
    expect(await call(tools, 'fail', {}, sandbox.session)).toEqual({
      exitCode: 3,
      stdout: '',
      stderr: 'no\n',
    });
    expect(await call(tools, 'fail', {})).toEqual({
      exitCode: null,
      error: 'This tool needs a sandbox.',
    });
  });

  it('stops a command at its timeout, and cuts a long output', async () => {
    const sandbox = await createHostSandbox();
    const { plugins } = await resolvePlugins([
      {
        name: 'shell',
        description: '',
        tools: {
          slow: {
            type: 'sandbox-command',
            description: 'Slow',
            command: 'sleep 5',
            timeoutSeconds: 1,
          },
          long: {
            type: 'sandbox-command',
            description: 'Long',
            command: 'head -c 25000 /dev/zero | tr "\\0" a',
          },
        },
      },
    ]);
    const slowSandbox = {
      ...sandbox.session,
      run: ({ abortSignal }: { abortSignal: AbortSignal }) =>
        new Promise((_, reject) =>
          abortSignal.addEventListener('abort', () => reject(new Error('aborted'))),
        ),
    };
    expect(await call(plugins[0]?.tools, 'slow', {}, slowSandbox)).toEqual({
      exitCode: null,
      error: 'Stopped after 1 s.',
    });
    const long = (await call(plugins[0]?.tools, 'long', {}, sandbox.session)) as { stdout: string };
    expect(long.stdout).toMatch(/^a{20000}\n\[… 5000 more characters cut\]$/);
  });

  it('takes the tools your code registers', async () => {
    const create = tool({
      description: 'Create',
      inputSchema: z.object({}),
      execute: () => 'created',
    });
    const { plugins } = await resolvePlugins(
      [
        {
          name: 'tickets',
          description: '',
          tools: { createTicket: { type: 'registered', ref: 'tickets.create' } },
        },
      ],
      { tools: { 'tickets.create': create } },
    );
    expect(plugins[0]?.tools?.createTicket).toBe(create);
    await expect(
      resolvePlugins([
        { name: 'tickets', description: '', tools: { x: { type: 'registered', ref: 'gone' } } },
      ]),
    ).rejects.toThrow('Plugin "tickets": its tool "gone" is not one your application registers.');
  });

  it('connects a host MCP server, keeps a sandbox one for the runtime, and closes the clients', async () => {
    const clients: HostMcpClient[] = [];
    const resolved = await resolvePlugins(
      [
        {
          name: 'vault',
          description: 'Secrets.',
          mcpServers: {
            host: {
              type: 'stdio',
              command: 'node',
              args: [SERVER],
              env: { SECRET_WORD: 'kiwi' },
              runIn: 'host',
              allowedTools: ['get_secret_word'],
            },
            box: {
              type: 'stdio',
              command: 'node',
              args: ['${PLUGIN_ROOT}/server.mjs'],
              runIn: 'sandbox',
            },
          },
        },
      ],
      {
        connectMcpServer: async (server, context) => {
          expect(context).toEqual({ plugin: 'vault', name: 'host' });
          expect(server).toEqual({
            type: 'stdio',
            command: 'node',
            args: [SERVER],
            env: { SECRET_WORD: 'kiwi' },
          });
          const client = await connect(server);
          clients.push(client);
          return client;
        },
      },
    );
    const [vault] = resolved.plugins;
    expect(Object.keys(vault?.tools ?? {})).toEqual(['host_get_secret_word']);
    expect(vault?.mcpServers).toEqual({
      box: {
        type: 'stdio',
        command: 'node',
        args: ['${PLUGIN_ROOT}/server.mjs'],
        runIn: 'sandbox',
      },
    });
    expect(await call(vault?.tools, 'host_get_secret_word', {})).toMatchObject({
      content: [{ type: 'text', text: 'The secret word is kiwi.' }],
    });
    await resolved.close();
    await expect(call(vault?.tools, 'host_get_secret_word', {})).rejects.toThrow();
  });

  it('connects MCP servers with @ai-sdk/mcp when given no connectMcpServer, one client each', async () => {
    const server = (word: string) => ({
      type: 'stdio',
      command: process.execPath,
      args: [SERVER],
      env: { SECRET_WORD: word },
    });
    const { plugins, close } = await resolvePlugins([
      {
        name: 'one',
        description: '',
        mcpServers: { alpha: server('apple'), beta: server('pear') },
      },
      { name: 'two', description: '', mcpServers: { gamma: server('plum') } },
    ]);
    expect(plugins.map(({ tools }) => Object.keys(tools ?? {}))).toEqual([
      ['alpha_get_secret_word', 'beta_get_secret_word'],
      ['gamma_get_secret_word'],
    ]);
    expect(await call(plugins[0]?.tools, 'beta_get_secret_word', {})).toMatchObject({
      content: [{ type: 'text', text: 'The secret word is pear.' }],
    });
    expect(await call(plugins[1]?.tools, 'gamma_get_secret_word', {})).toMatchObject({
      content: [{ type: 'text', text: 'The secret word is plum.' }],
    });
    await close();
  });

  it('refuses two MCP servers of one name, whose tools would collide', async () => {
    const docs = { type: 'http', url: 'https://docs.example.com' };
    await expect(
      resolvePlugins([
        { name: 'one', description: '', mcpServers: { docs } },
        { name: 'two', description: '', mcpServers: { docs } },
      ]),
    ).rejects.toThrow('Plugin "two": its MCP server "docs" is also one of "one".');
  });

  it('closes what it opened when a plugin fails', async () => {
    const close = vi.fn();
    const plugins = [
      {
        name: 'one',
        description: '',
        mcpServers: { a: { type: 'http', url: 'https://a.example.com' } },
      },
      { name: 'two', description: '', tools: { x: { type: 'registered', ref: 'missing' } } },
    ];
    await expect(
      resolvePlugins(plugins, {
        connectMcpServer: () => Promise.resolve({ tools: () => Promise.resolve({}), close }),
      }),
    ).rejects.toThrow('its tool "missing"');
    expect(close).toHaveBeenCalledOnce();
    await expect(resolvePlugins([{ name: 'Bad' }])).rejects.toThrow(
      'name: must be a kebab-case slug',
    );
  });

  it('refuses a secret in a server run in the sandbox', async () => {
    await expect(
      resolvePlugins([
        {
          name: 'box',
          description: '',
          mcpServers: {
            s: { type: 'stdio', command: 'x', env: { TOKEN: { secret: 'T' } }, runIn: 'sandbox' },
          },
        },
      ]),
    ).rejects.toThrow(
      'mcpServers.s: holds a secret: an MCP server with credentials is connected by your server',
    );
  });
});

describe('environmentOf', () => {
  it('gives the whole input, and each property by its name in capitals', () => {
    expect(environmentOf({ path: 'src', 'max-count': 3, deep: { a: 1 }, none: undefined })).toEqual(
      {
        INPUT: '{"path":"src","max-count":3,"deep":{"a":1}}',
        INPUT_PATH: 'src',
        INPUT_MAX_COUNT: '3',
        INPUT_DEEP: '{"a":1}',
      },
    );
  });
});
