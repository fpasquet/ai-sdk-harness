import type { PluginSubagent } from '../definitions/plugin.js';
import type { PluginRuntime, SessionFile } from './plugin-runtime.js';

import { stringifyToml } from '../utils/toml.js';

/** Where Codex reads a project's own subagents, one TOML file each. */
const AGENTS_DIR = '.codex/agents';

/** The models of a subagent written for Claude Code, which name no Codex model: Codex's default. */
const CLAUDE_CODE_MODELS = new Set(['haiku', 'inherit', 'opus', 'sonnet']);

/**
 * Codex: MCP servers in the form of its `mcp_servers` configuration, subagents as its agent files
 * in the session's `.codex/agents/`. Codex reads that directory in a project it trusts, and trusts
 * the session's on its own: its app server does so for a thread with full access to the working
 * directory, which the harness always starts. Its hooks have to be trusted by hash before they
 * run, which the harness does not expose yet. Rules go in the agent's instructions.
 */
export const codexRuntime: PluginRuntime = {
  harnessId: 'codex',
  supports: { hooks: false, mcpServers: true, subagents: true },
  rules: 'instructions',
  mcpServer: (server) =>
    server.type === 'stdio'
      ? { command: server.command, args: server.args ?? [], env: server.env ?? {} }
      : { url: server.url, ...(server.headers && { http_headers: server.headers }) },
  layout: (plugins) => ({
    files: plugins.flatMap((plugin) => (plugin.subagents ?? []).map(subagentFile)),
    hookGroups: {},
  }),
};

/**
 * An agent file of Codex. It has no list of tools: a subagent has the main agent's, whatever its
 * `tools` say.
 */
function subagentFile(subagent: PluginSubagent): SessionFile {
  const model =
    subagent.model === undefined || CLAUDE_CODE_MODELS.has(subagent.model)
      ? undefined
      : subagent.model;
  return {
    path: `${AGENTS_DIR}/${subagent.name}.toml`,
    content: stringifyToml({
      name: subagent.name,
      description: subagent.description,
      developer_instructions: subagent.instructions,
      model,
    }),
  };
}
