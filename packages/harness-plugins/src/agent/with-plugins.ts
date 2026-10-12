import type { HarnessAgentSandboxConfig, HarnessAgentSkill } from '@ai-sdk/harness/agent';
import type { SystemModelMessage, ToolSet } from '@ai-sdk/provider-utils';

import { posix } from 'node:path';

import type { Plugin } from '../definitions/plugin.js';
import type { PluginFeature, PluginRuntime, SessionLayout } from '../runtimes/plugin-runtime.js';

import { readyTool } from '../config/resolve-plugins.js';
import { checkPlugin } from '../definitions/plugin.js';
import { InvalidPluginError } from '../errors/invalid-plugin-error.js';
import { rulesAsInstructions } from '../runtimes/rules.js';
import { runtimeFor } from '../runtimes/runtime-for.js';
import { STATE_DIR, syncSessionFiles } from '../session/sync-session-files.js';

/** The settings of a `HarnessAgent` the plugins take part in. */
export interface PluginAgentSettings {
  readonly harness: { readonly harnessId: string; readonly builtinTools: object };
  readonly tools?: ToolSet;
  readonly skills?: ReadonlyArray<HarnessAgentSkill>;
  readonly activeTools?: ReadonlyArray<string>;
  readonly instructions?: string | SystemModelMessage;
  readonly sandboxConfig?: HarnessAgentSandboxConfig;
  /** @deprecated Use `sandboxConfig.onSession` instead. */
  readonly onSandboxSession?: HarnessAgentSandboxConfig['onSession'];
}

/**
 * What {@link withPlugins} returns: the settings it was given, the plugins' tools and skills
 * merged in, and a `sandboxConfig.onSession` that writes their files.
 */
export type WithPlugins<SETTINGS extends PluginAgentSettings> = Omit<
  SETTINGS,
  'onSandboxSession' | 'sandboxConfig'
> & {
  readonly sandboxConfig: HarnessAgentSandboxConfig;
  /** The agent's tools, and those of the plugins. */
  readonly tools?: ToolSet;
  /** The agent's instructions, and the rules on a runtime that has none of its own. */
  readonly instructions?: string | SystemModelMessage;
};

/** A feature of a plugin the agent's runtime cannot take: it is left out. */
export interface UnsupportedPluginFeature {
  plugin: string;
  feature: PluginFeature;
  harnessId: string;
}

export interface WithPluginsOptions {
  /**
   * Called for each plugin feature the runtime cannot take (Codex and hooks, for instance), which
   * is then left out. Throw from it to refuse such a plugin instead.
   *
   * @defaultValue a Node.js process warning
   */
  onUnsupported?: (unsupported: UnsupportedPluginFeature) => void;
}

/** The tool Claude Code loads skills with: an allow-list must let it through for skills to work. */
const SKILL_TOOL = 'Skill';

/**
 * `settings` with `plugins` applied, ready for `new HarnessAgent(…)`:
 *
 * - their **tools** join `tools` (and `activeTools`, when it is an allow-list);
 * - their **skills** join `skills`, written by the harness the way the runtime reads them;
 * - their **rules** are written where Claude Code reads them, and join `instructions` on the
 *   runtimes that have none;
 * - their **hooks**, **subagents** and **files** are written in each session's working directory
 *   by `sandboxConfig.onSession`, after your own, at creation and at every resume — so a resumed
 *   session runs with the plugins the agent has now.
 *
 * Commands are expanded by {@link expandCommand} before the prompt reaches the agent, and MCP
 * servers belong to the harness adapter: see {@link pluginHarnessSettings}.
 *
 * Throws {@link InvalidPluginError} when two plugins, or a plugin and `settings`, give one name
 * to two tools or two skills, or when a tool takes the name of one of the runtime's own.
 */
export function withPlugins<SETTINGS extends PluginAgentSettings>(
  settings: SETTINGS,
  plugins: readonly Plugin[],
  options: WithPluginsOptions = {},
): WithPlugins<SETTINGS> {
  const runtime = runtimeFor(settings.harness.harnessId);
  plugins.forEach(checkPlugin);
  reportUnsupported(runtime, plugins, options.onUnsupported ?? emitWarning);
  const tools = mergeTools(settings, plugins);
  const skills = mergeSkills(settings, plugins);
  const instructions =
    runtime.rules === 'instructions'
      ? withRules(settings.instructions, rulesAsInstructions(plugins))
      : undefined;
  const onSession = settings.sandboxConfig?.onSession ?? settings.onSandboxSession;
  const { onSandboxSession: _deprecated, ...rest } = settings;
  // The settings as given, but for what is set below: a generic `Omit` TypeScript cannot follow.
  return {
    ...rest,
    ...(tools !== undefined && { tools }),
    ...(skills !== undefined && { skills }),
    ...(instructions !== undefined && { instructions }),
    ...(settings.activeTools !== undefined && {
      activeTools: activeToolsOf(settings, plugins, tools),
    }),
    sandboxConfig: {
      ...settings.sandboxConfig,
      onSession: async (input) => {
        await onSession?.(input);
        await syncSessionFiles({
          ...input,
          layout: layoutOf(runtime, plugins, input.sessionWorkDir),
        });
      },
    },
  } as WithPlugins<SETTINGS>;
}

/** What the runtime reads in a session's working directory, the plugins' own files included. */
function layoutOf(
  runtime: PluginRuntime,
  plugins: readonly Plugin[],
  sessionWorkDir: string,
): SessionLayout {
  const relativeRoot = (plugin: string): string => posix.join(STATE_DIR, 'plugins', plugin);
  const { files, hookGroups } = runtime.layout(plugins, (plugin) =>
    posix.join(sessionWorkDir, relativeRoot(plugin)),
  );
  const supported = plugins.flatMap((plugin) =>
    (plugin.files ?? []).map((file) => ({
      ...file,
      path: posix.join(relativeRoot(plugin.name), file.path),
    })),
  );
  return { files: [...supported, ...files], hookGroups };
}

function reportUnsupported(
  runtime: PluginRuntime,
  plugins: readonly Plugin[],
  report: (unsupported: UnsupportedPluginFeature) => void,
): void {
  for (const plugin of plugins) {
    const present: Record<PluginFeature, boolean> = {
      hooks: (plugin.hooks ?? []).length > 0,
      mcpServers: Object.keys(plugin.mcpServers ?? {}).length > 0,
      subagents: (plugin.subagents ?? []).length > 0,
    };
    for (const feature of ['hooks', 'subagents', 'mcpServers'] as const) {
      if (present[feature] && !runtime.supports[feature]) {
        report({ plugin: plugin.name, feature, harnessId: runtime.harnessId });
      }
    }
  }
}

function mergeTools(
  settings: PluginAgentSettings,
  plugins: readonly Plugin[],
): ToolSet | undefined {
  const reserved = new Map(
    Object.keys(settings.harness.builtinTools).map((name) => [
      name.toLowerCase(),
      `the runtime's own ${name}`,
    ]),
  );
  for (const name of Object.keys(settings.tools ?? {}))
    reserved.set(name.toLowerCase(), 'a tool of the agent');
  let merged = settings.tools;
  for (const plugin of plugins) {
    for (const name of Object.keys(plugin.tools ?? {})) {
      const owner = reserved.get(name.toLowerCase());
      if (owner !== undefined) {
        throw new InvalidPluginError(`its tool "${name}" has the name of ${owner}.`, plugin.name);
      }
      reserved.set(name.toLowerCase(), `a tool of plugin "${plugin.name}"`);
    }
    const tools = readyTools(plugin);
    if (Object.keys(tools).length > 0) merged = { ...merged, ...tools };
  }
  return merged;
}

/** The tools of `plugin`, built; throws for one that needs `resolvePlugins` first. */
function readyTools(plugin: Plugin): ToolSet {
  const toConnect = Object.entries(plugin.mcpServers ?? {}).find(
    ([, server]) => server.runIn !== 'sandbox',
  );
  if (toConnect !== undefined) {
    throw new InvalidPluginError(
      `its MCP server "${toConnect[0]}" is connected by your server: resolve the plugins with resolvePlugins() first.`,
      plugin.name,
    );
  }
  const tools: ToolSet = {};
  for (const [name, written] of Object.entries(plugin.tools ?? {})) {
    const tool = readyTool(written);
    if (tool === undefined) {
      throw new InvalidPluginError(
        `its tool "${name}" refers to a secret or a tool of your application: resolve the plugins with resolvePlugins() first.`,
        plugin.name,
      );
    }
    tools[name] = tool;
  }
  return tools;
}

function mergeSkills(
  settings: PluginAgentSettings,
  plugins: readonly Plugin[],
): HarnessAgentSkill[] | undefined {
  const owners = new Map((settings.skills ?? []).map(({ name }) => [name, 'a skill of the agent']));
  const skills = [...(settings.skills ?? [])];
  for (const plugin of plugins) {
    for (const skill of plugin.skills ?? []) {
      const owner = owners.get(skill.name);
      if (owner !== undefined) {
        throw new InvalidPluginError(
          `its skill "${skill.name}" has the name of ${owner}.`,
          plugin.name,
        );
      }
      owners.set(skill.name, `a skill of plugin "${plugin.name}"`);
      // What a catalog reads of it, not the harness.
      const { requires: _requires, ...harnessSkill } = skill;
      skills.push(harnessSkill);
    }
  }
  return settings.skills === undefined && skills.length === 0 ? undefined : skills;
}

/** The allow-list, with the plugins' tools — and the runtime's skill tool when they bring skills. */
function activeToolsOf(
  settings: PluginAgentSettings,
  plugins: readonly Plugin[],
  tools: ToolSet | undefined,
): string[] {
  const own = new Set(Object.keys(settings.tools ?? {}));
  const added = Object.keys(tools ?? {}).filter((name) => !own.has(name));
  const skills = plugins.some(({ skills }) => (skills ?? []).length > 0);
  const skillTool = skills && SKILL_TOOL in settings.harness.builtinTools ? [SKILL_TOOL] : [];
  return [...new Set([...(settings.activeTools ?? []), ...added, ...skillTool])];
}

/** The agent's instructions, the rules after them. */
function withRules(
  own: string | SystemModelMessage | undefined,
  rules: string | undefined,
): string | SystemModelMessage | undefined {
  if (rules === undefined || own === undefined) return rules;
  return typeof own === 'string'
    ? `${own}\n\n${rules}`
    : { ...own, content: `${own.content}\n\n${rules}` };
}

function emitWarning({ plugin, feature, harnessId }: UnsupportedPluginFeature): void {
  process.emitWarning(
    `Plugin "${plugin}": ${harnessId} does not support ${feature}; they are left out.`,
    'AiSdkHarnessPluginsWarning',
  );
}
