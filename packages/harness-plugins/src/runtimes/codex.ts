import { createHash } from 'node:crypto';

import type { Plugin, PluginHook, PluginHookEvent, PluginSubagent } from '../definitions/plugin.js';
import type { PluginRuntime, SessionFile } from './plugin-runtime.js';

import { PLUGIN_ROOT } from '../definitions/plugin.js';
import { stringifyToml } from '../utils/toml.js';

/** Where Codex reads a project's own subagents, one TOML file each. */
const AGENTS_DIR = '.codex/agents';

/** The models of a subagent written for Claude Code, which name no Codex model: Codex's default. */
const CLAUDE_CODE_MODELS = new Set(['haiku', 'inherit', 'opus', 'sonnet']);

/**
 * The events of Codex, by the name of the hook's: its own name, in its trust keys, and whether it
 * reads the matcher. Codex has no `Notification` nor `PostToolUseFailure`.
 */
const CODEX_EVENTS: Partial<Record<PluginHookEvent, { key: string; matcher: boolean }>> = {
  PostToolUse: { key: 'post_tool_use', matcher: true },
  PreCompact: { key: 'pre_compact', matcher: true },
  PreToolUse: { key: 'pre_tool_use', matcher: true },
  SessionEnd: { key: 'session_end', matcher: true },
  SessionStart: { key: 'session_start', matcher: true },
  Stop: { key: 'stop', matcher: false },
  SubagentStart: { key: 'subagent_start', matcher: true },
  SubagentStop: { key: 'subagent_stop', matcher: true },
  UserPromptSubmit: { key: 'user_prompt_submit', matcher: false },
};

/**
 * Where Codex says the hooks of the configuration a client passes come from: it merges that
 * configuration into its session flags, the layer of its `--config` overrides.
 */
const SESSION_FLAGS = '/<session-flags>/config.toml';

/**
 * Codex: MCP servers in the form of its `mcp_servers` configuration, subagents as its agent files
 * in the session's `.codex/agents/`. Codex reads that directory in a project it trusts, and trusts
 * the session's on its own: its app server does so for a thread with full access to the working
 * directory, which the harness always starts. Hooks go in the adapter's configuration, each with
 * the hash Codex trusts it by, since it runs none it has not trusted: commands only, Codex skipping
 * prompts. Rules go in the agent's instructions.
 */
export const codexRuntime: PluginRuntime = {
  harnessId: 'codex',
  supports: { hooks: true, mcpServers: true, subagents: true },
  rules: 'instructions',
  mcpServer: (server) =>
    server.type === 'stdio'
      ? { command: server.command, args: server.args ?? [], env: server.env ?? {} }
      : { url: server.url, ...(server.headers && { http_headers: server.headers }) },
  layout: (plugins) => ({
    files: plugins.flatMap((plugin) => (plugin.subagents ?? []).map(subagentFile)),
    hookGroups: {},
  }),
  takesHook: (hook) => hook.command !== undefined && CODEX_EVENTS[hook.event] !== undefined,
  adapterSettings: (plugins, pluginRoot) => {
    const hooks = trustedHooks(plugins, pluginRoot);
    return hooks === undefined ? {} : { codexConfig: { hooks } };
  },
};

/**
 * The hooks Codex takes, each a matcher group of its own under its event, in the order of the
 * plugins, and the state that trusts each: `enabled`, and the hash of the hook as Codex computes
 * it, under the key it looks it up by.
 */
function trustedHooks(
  plugins: readonly Plugin[],
  pluginRoot: (plugin: string) => string,
): Record<string, unknown> | undefined {
  const hooks: Record<string, unknown[]> = {};
  const state: Record<string, { enabled: true; trusted_hash: string }> = {};
  for (const plugin of plugins) {
    for (const hook of plugin.hooks ?? []) {
      const event = CODEX_EVENTS[hook.event];
      if (hook.command === undefined || event === undefined) continue;
      const matcher = event.matcher ? hook.matcher : undefined;
      const group = {
        ...(matcher !== undefined && { matcher }),
        hooks: [
          {
            type: 'command',
            command: hook.command.replace(PLUGIN_ROOT, pluginRoot(plugin.name)),
            timeout: timeoutOf(hook),
            async: false,
          },
        ],
      };
      const groups = (hooks[hook.event] ??= []);
      state[`${SESSION_FLAGS}:${event.key}:${groups.length}:0`] = {
        enabled: true,
        trusted_hash: trustedHash(event.key, group),
      };
      groups.push(group);
    }
  }
  return Object.keys(state).length > 0 ? { ...hooks, state } : undefined;
}

/**
 * The timeout as Codex settles it, in seconds, for the hash: given, it would hash the one it
 * settles on all the same. `SessionEnd` gets 1 to 3 seconds, 1 by default; the rest 10 minutes.
 */
function timeoutOf({ event, timeout }: PluginHook): number {
  if (event === 'SessionEnd') return Math.min(Math.max(timeout ?? 1, 1), 3);
  return Math.max(timeout ?? 600, 1);
}

/** Codex's hash of a hook: SHA-256 of the JSON of its event and group, keys sorted. */
function trustedHash(event: string, group: Record<string, unknown>): string {
  const identity = JSON.stringify(sortedKeys({ event_name: event, ...group }));
  return `sha256:${createHash('sha256').update(identity).digest('hex')}`;
}

function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => [key, sortedKeys(item)]),
  );
}

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
