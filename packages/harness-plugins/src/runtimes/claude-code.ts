import { createHash } from 'node:crypto';

import type { Plugin, PluginHook, PluginSubagent } from '../definitions/plugin.js';
import type { PluginRuntime, SessionFile } from './plugin-runtime.js';

import { PLUGIN_ROOT } from '../definitions/plugin.js';
import { stringifyFrontmatter } from '../utils/frontmatter.js';

/**
 * Where Claude Code reads the session's own settings, beside the project's `.claude/settings.json`:
 * where an earlier version of the package wrote the hooks.
 */
export const CLAUDE_LOCAL_SETTINGS = '.claude/settings.local.json';

/** The script, under `$HOME`, each hook of the plugins goes through: it runs the session's own. */
export const HOOK_GATE = '.ai-sdk-harness/hook-gate.sh';
/** Where, in the session's state directory, the gate finds the commands of its hooks. */
const SESSION_HOOKS = '.ai-sdk-harness/hooks';

/**
 * The gate: runs hook `$1` of the session Claude Code works in, with the event on its standard
 * input, or does nothing in a session without it — every session of the sandbox reads the hooks
 * of `$HOME`.
 */
export const HOOK_GATE_SCRIPT = [
  '#!/bin/sh',
  `hook="\${CLAUDE_PROJECT_DIR:-$PWD}/${SESSION_HOOKS}/$1"`,
  '[ -f "$hook" ] || exit 0',
  'exec sh "$hook"',
  '',
].join('\n');

/**
 * Claude Code: everything but prompt hooks. `@ai-sdk/harness-claude-code` 1.0.180 and later
 * starts Claude Code with the user's settings alone (`settingSources: ['user']`), so it reads
 * nothing of the session's `.claude/` (vercel/ai#21714), and the plugins write under the sandbox's
 * `$HOME`, which every session shares:
 *
 * - subagents in `.claude/agents/`, as the adapter writes its skills in `.claude/skills/`;
 * - hooks in `.claude/settings.json`, each one through {@link HOOK_GATE}, which runs the command
 *   the session holds for it, `${PLUGIN_ROOT}` pointing at its own files, and nothing in a
 *   session without it. A prompt hook has no command to go through it, and is left out.
 *
 * Rules go in the agent's instructions, as on every runtime.
 */
export const claudeCodeRuntime: PluginRuntime = {
  harnessId: 'claude-code',
  supports: { hooks: true, mcpServers: true, subagents: true },
  mcpServer: (server) =>
    server.type === 'stdio'
      ? { type: 'stdio', command: server.command, args: server.args ?? [], env: server.env ?? {} }
      : { type: 'http', url: server.url, headers: server.headers ?? {} },
  layout: (plugins, pluginRoot) => {
    const hooks = commandHooksOf(plugins, pluginRoot);
    return {
      files: hooks.map(({ id, command }) => ({
        path: `${SESSION_HOOKS}/${id}`,
        content: `${command}\n`,
      })),
      homeFiles: plugins.flatMap((plugin) => (plugin.subagents ?? []).map(subagentFile)),
      hookGroups: hookGroupsOf(hooks),
    };
  },
  takesHook: (hook) => hook.command !== undefined,
};

interface CommandHook {
  /** Names the hook in `$HOME` and in the session alike: a hash of the plugin and the hook. */
  id: string;
  hook: PluginHook;
  /** The command, `${PLUGIN_ROOT}` replaced with the plugin's directory in the session. */
  command: string;
}

/** The command hooks of the plugins, in their order. */
function commandHooksOf(
  plugins: readonly Plugin[],
  pluginRoot: (plugin: string) => string,
): CommandHook[] {
  return plugins.flatMap((plugin) =>
    (plugin.hooks ?? []).flatMap((hook) =>
      hook.command === undefined
        ? []
        : [
            {
              id: hookId(plugin.name, hook),
              hook,
              command: hook.command.replace(PLUGIN_ROOT, pluginRoot(plugin.name)),
            },
          ],
    ),
  );
}

function hookId(plugin: string, { event, matcher, command, timeout }: PluginHook): string {
  const content = JSON.stringify([plugin, event, matcher ?? null, command, timeout ?? null]);
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/** Each hook a matcher group of its own under its event, its command the gate. */
function hookGroupsOf(hooks: readonly CommandHook[]): Record<string, unknown[]> {
  const groups: Record<string, unknown[]> = {};
  for (const { id, hook } of hooks) {
    (groups[hook.event] ??= []).push({
      ...(hook.matcher !== undefined && { matcher: hook.matcher }),
      hooks: [
        {
          type: 'command',
          command: `sh "$HOME/${HOOK_GATE}" ${id}`,
          ...(hook.timeout !== undefined && { timeout: hook.timeout }),
        },
      ],
    });
  }
  return groups;
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
