import type { PluginRuntime } from './plugin-runtime.js';

import { EMPTY_LAYOUT } from './plugin-runtime.js';

/**
 * Codex: MCP servers in the form of its `mcp_servers` configuration. Its hooks have to be trusted
 * by hash before they run, which the harness does not expose yet, and it has no subagents. Rules
 * go in the agent's instructions.
 */
export const codexRuntime: PluginRuntime = {
  harnessId: 'codex',
  supports: { hooks: false, mcpServers: true, subagents: false },
  rules: 'instructions',
  mcpServer: (server) =>
    server.type === 'stdio'
      ? { command: server.command, args: server.args ?? [], env: server.env ?? {} }
      : { url: server.url, ...(server.headers && { http_headers: server.headers }) },
  layout: () => EMPTY_LAYOUT,
};
