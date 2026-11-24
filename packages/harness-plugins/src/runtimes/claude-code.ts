import type { Plugin, PluginHook, PluginSubagent } from '../definitions/plugin.js';
import type { PluginRuntime, SessionFile } from './plugin-runtime.js';

import { PLUGIN_ROOT } from '../definitions/plugin.js';
import { stringifyFrontmatter } from '../utils/frontmatter.js';

/** Where Claude Code reads the session's own settings, beside the project's `.claude/settings.json`. */
export const CLAUDE_LOCAL_SETTINGS = '.claude/settings.local.json';

/**
 * Claude Code: everything. Subagents go in `.claude/agents/` under the sandbox's `$HOME`, and
 * hooks in the session's `.claude/settings.local.json`. Rules go in the agent's instructions, as on
 * every runtime. `@ai-sdk/harness-claude-code` 1.0.180 and later starts Claude Code with the
 * user's settings alone (`settingSources: ['user']`): it reads the subagents of `$HOME`, as it
 * reads the skills the adapter writes there, but nothing of the session's `.claude/`, so the hooks
 * wait for the adapter to let that be set (vercel/ai#21714).
 */
export const claudeCodeRuntime: PluginRuntime = {
  harnessId: 'claude-code',
  supports: { hooks: true, mcpServers: true, subagents: true },
  mcpServer: (server) =>
    server.type === 'stdio'
      ? { type: 'stdio', command: server.command, args: server.args ?? [], env: server.env ?? {} }
      : { type: 'http', url: server.url, headers: server.headers ?? {} },
  layout: (plugins, pluginRoot) => ({
    files: [],
    homeFiles: plugins.flatMap((plugin) => (plugin.subagents ?? []).map(subagentFile)),
    hookGroups: hookGroupsOf(plugins, pluginRoot),
  }),
};

/** Each hook a matcher group of its own under its event, in the order of the plugins. */
function hookGroupsOf(
  plugins: readonly Plugin[],
  pluginRoot: (plugin: string) => string,
): Record<string, unknown[]> {
  const groups: Record<string, unknown[]> = {};
  for (const plugin of plugins) {
    for (const hook of plugin.hooks ?? []) {
      (groups[hook.event] ??= []).push({
        ...(hook.matcher !== undefined && { matcher: hook.matcher }),
        hooks: [handlerOf(hook, pluginRoot(plugin.name))],
      });
    }
  }
  return groups;
}

function handlerOf(hook: PluginHook, root: string): Record<string, unknown> {
  const timeout = hook.timeout === undefined ? {} : { timeout: hook.timeout };
  return hook.command === undefined
    ? { type: 'prompt', prompt: hook.prompt, ...timeout }
    : { type: 'command', command: hook.command.replace(PLUGIN_ROOT, root), ...timeout };
}

function subagentFile(subagent: PluginSubagent): SessionFile {
  return {
    path: `.claude/agents/${subagent.name}.md`,
    content: stringifyFrontmatter(
      {
        name: subagent.name,
        description: subagent.description,
        tools: subagent.tools?.join(', '),
        model: subagent.model,
      },
      subagent.instructions,
    ),
  };
}
