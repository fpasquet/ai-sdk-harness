import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import type { Plugin } from '../definitions/plugin.js';

import { pluginHarnessSettings } from './plugin-harness-settings.js';

const servers: Plugin = {
  name: 'servers',
  description: '',
  mcpServers: {
    local: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'server'],
      env: { LEVEL: 'info' },
      runIn: 'sandbox',
    },
    bare: { type: 'stdio', command: 'server', runIn: 'sandbox' },
    remote: {
      type: 'http',
      url: 'https://mcp.example.com',
      headers: { Authorization: 'Bearer x' },
      runIn: 'sandbox',
    },
    open: { type: 'http', url: 'https://open.example.com', runIn: 'sandbox' },
  },
};

describe('pluginHarnessSettings', () => {
  it('gives Claude Code its MCP servers in its own format', () => {
    expect(pluginHarnessSettings('claude-code', [servers])).toEqual({
      mcpServers: {
        local: {
          type: 'stdio',
          command: 'npx',
          args: ['-y', 'server'],
          env: { LEVEL: 'info' },
        },
        bare: { type: 'stdio', command: 'server', args: [], env: {} },
        remote: {
          type: 'http',
          url: 'https://mcp.example.com',
          headers: { Authorization: 'Bearer x' },
        },
        open: { type: 'http', url: 'https://open.example.com', headers: {} },
      },
    });
  });

  it('gives Codex its MCP servers in the form of its configuration', () => {
    expect(pluginHarnessSettings('codex', [servers])).toEqual({
      mcpServers: {
        local: { command: 'npx', args: ['-y', 'server'], env: { LEVEL: 'info' } },
        bare: { command: 'server', args: [], env: {} },
        remote: { url: 'https://mcp.example.com', http_headers: { Authorization: 'Bearer x' } },
        open: { url: 'https://open.example.com' },
      },
    });
  });

  it('gives Codex the hooks it takes, each trusted by the hash Codex computes', () => {
    const guard: Plugin = {
      name: 'guard',
      description: '',
      hooks: [
        { event: 'PreToolUse', matcher: 'Bash', command: '"${PLUGIN_ROOT}/guard.sh"', timeout: 5 },
        { event: 'PreToolUse', command: 'audit' },
        { event: 'Stop', matcher: 'ignored', command: 'check' },
        { event: 'SessionEnd', command: 'bye', timeout: 30 },
        { event: 'Stop', prompt: 'Is the work done?' },
        { event: 'Notification', command: 'notify' },
      ],
    };
    const sha = (identity: string): string =>
      `sha256:${createHash('sha256').update(identity).digest('hex')}`;
    expect(pluginHarnessSettings('codex', [guard])).toEqual({
      codexConfig: {
        hooks: {
          PreToolUse: [
            {
              matcher: 'Bash',
              hooks: [
                {
                  type: 'command',
                  command: '".ai-sdk-harness/plugins/guard/guard.sh"',
                  timeout: 5,
                  async: false,
                },
              ],
            },
            { hooks: [{ type: 'command', command: 'audit', timeout: 600, async: false }] },
          ],
          // Codex reads no matcher for Stop, and gives SessionEnd 3 seconds at most.
          Stop: [{ hooks: [{ type: 'command', command: 'check', timeout: 600, async: false }] }],
          SessionEnd: [{ hooks: [{ type: 'command', command: 'bye', timeout: 3, async: false }] }],
          state: {
            '/<session-flags>/config.toml:pre_tool_use:0:0': {
              enabled: true,
              trusted_hash: sha(
                '{"event_name":"pre_tool_use","hooks":[{"async":false,"command":"\\".ai-sdk-harness/plugins/guard/guard.sh\\"","timeout":5,"type":"command"}],"matcher":"Bash"}',
              ),
            },
            '/<session-flags>/config.toml:pre_tool_use:1:0': {
              enabled: true,
              trusted_hash: sha(
                '{"event_name":"pre_tool_use","hooks":[{"async":false,"command":"audit","timeout":600,"type":"command"}]}',
              ),
            },
            '/<session-flags>/config.toml:stop:0:0': {
              enabled: true,
              trusted_hash: sha(
                '{"event_name":"stop","hooks":[{"async":false,"command":"check","timeout":600,"type":"command"}]}',
              ),
            },
            '/<session-flags>/config.toml:session_end:0:0': {
              enabled: true,
              trusted_hash: sha(
                '{"event_name":"session_end","hooks":[{"async":false,"command":"bye","timeout":3,"type":"command"}]}',
              ),
            },
          },
        },
      },
    });
    // Claude Code reads its hooks from the session's files.
    expect(pluginHarnessSettings('claude-code', [guard])).toEqual({});
    expect(pluginHarnessSettings('codex', [{ ...guard, hooks: [guard.hooks![4]!] }])).toEqual({});
  });

  it('is empty without servers, and for a runtime it does not know', () => {
    expect(pluginHarnessSettings('claude-code', [{ name: 'none', description: '' }])).toEqual({});
    expect(pluginHarnessSettings('opencode', [servers])).toEqual({});
  });

  it('points ${PLUGIN_ROOT} at the plugin files, relative to the session where the runtime starts it', () => {
    const shipped: Plugin = {
      name: 'shipped',
      description: '',
      mcpServers: {
        box: {
          type: 'stdio',
          command: '${CLAUDE_PLUGIN_ROOT}/bin/server',
          args: ['--config', '${PLUGIN_ROOT}/config.json'],
          env: { DATA: '${PLUGIN_ROOT}/data' },
          runIn: 'sandbox',
        },
      },
    };
    expect(pluginHarnessSettings('codex', [shipped]).mcpServers).toEqual({
      box: {
        command: '.ai-sdk-harness/plugins/shipped/bin/server',
        args: ['--config', '.ai-sdk-harness/plugins/shipped/config.json'],
        env: { DATA: '.ai-sdk-harness/plugins/shipped/data' },
      },
    });
  });

  it('leaves out a server your server connects to, and refuses an unresolved secret', () => {
    const host: Plugin = {
      name: 'host',
      description: '',
      mcpServers: { docs: { type: 'http', url: 'https://docs.example.com', runIn: 'host' } },
    };
    expect(pluginHarnessSettings('claude-code', [host])).toEqual({});
    const secret: Plugin = {
      name: 'secret',
      description: '',
      mcpServers: {
        box: {
          type: 'stdio',
          command: 'server',
          env: { TOKEN: { secret: 'T' } },
          runIn: 'sandbox',
        },
      },
    };
    expect(() => pluginHarnessSettings('codex', [secret])).toThrow(
      'Plugin "secret": its MCP server "box" refers to a secret: resolve the plugins with resolvePlugins() first.',
    );
  });

  it('refuses two servers of one name', () => {
    const twin: Plugin = {
      name: 'twin',
      description: '',
      mcpServers: { local: { type: 'stdio', command: 'x', runIn: 'sandbox' } },
    };
    expect(() => pluginHarnessSettings('claude-code', [servers, twin])).toThrow(
      'Plugin "twin": its MCP server "local" is also one of "servers".',
    );
  });
});
