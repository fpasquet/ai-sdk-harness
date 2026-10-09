import type { ItemKind } from '../config/item-schema.js';
import type { Plugin } from '../definitions/plugin.js';

import { hookNameOf } from '../definitions/plugin.js';

/** One item of a plugin: its kind, its name, and what it needs. */
export interface PluginItem {
  kind: ItemKind;
  name: string;
  requires: string[];
}

const requiresOf = (value: unknown): string[] =>
  (value as undefined | { requires?: string[] })?.requires ?? [];

/** Every item of `plugin`, in the order of its kinds. */
export function itemsOf(plugin: Plugin): PluginItem[] {
  return [
    ...Object.entries(plugin.tools ?? {}).map(([name, tool]) => ({
      kind: 'tool' as const,
      name,
      requires: requiresOf(tool),
    })),
    ...(plugin.skills ?? []).map((skill) => ({
      kind: 'skill' as const,
      name: skill.name,
      requires: requiresOf(skill),
    })),
    ...(plugin.rules ?? []).map((rule) => ({
      kind: 'rule' as const,
      name: rule.name,
      requires: requiresOf(rule),
    })),
    ...(plugin.commands ?? []).map((command) => ({
      kind: 'command' as const,
      name: command.name,
      requires: requiresOf(command),
    })),
    ...(plugin.hooks ?? []).map((hook, index) => ({
      kind: 'hook' as const,
      name: hookNameOf(hook, index),
      requires: requiresOf(hook),
    })),
    ...(plugin.subagents ?? []).map((subagent) => ({
      kind: 'subagent' as const,
      name: subagent.name,
      requires: requiresOf(subagent),
    })),
    ...Object.keys(plugin.mcpServers ?? {}).map((name) => ({
      kind: 'mcp-server' as const,
      name,
      requires: [],
    })),
  ];
}

/** `<kind>:<name>`: an item, within its plugin. */
export const itemKey = ({ kind, name }: { kind: ItemKind; name: string }): string =>
  `${kind}:${name}`;

/**
 * `plugin` with only the items `keep` names (`<kind>:<name>`), its files all kept: a hook or an
 * MCP server picked alone still finds its scripts.
 */
export function filterPlugin<PLUGIN extends Plugin>(
  plugin: PLUGIN,
  keep: ReadonlySet<string>,
): PLUGIN {
  const has = (kind: ItemKind, name: string): boolean => keep.has(`${kind}:${name}`);
  const { tools, skills, rules, commands, hooks, subagents, mcpServers, ...rest } = plugin;
  return {
    ...rest,
    ...nonEmpty(
      'tools',
      pick(tools as Record<string, unknown> | undefined, (name) => has('tool', name)),
    ),
    ...nonEmpty(
      'skills',
      skills?.filter(({ name }) => has('skill', name)),
    ),
    ...nonEmpty(
      'rules',
      rules?.filter(({ name }) => has('rule', name)),
    ),
    ...nonEmpty(
      'commands',
      commands?.filter(({ name }) => has('command', name)),
    ),
    ...nonEmpty(
      'hooks',
      hooks?.filter((hook, index) => has('hook', hookNameOf(hook, index))),
    ),
    ...nonEmpty(
      'subagents',
      subagents?.filter(({ name }) => has('subagent', name)),
    ),
    ...nonEmpty(
      'mcpServers',
      pick(mcpServers as Record<string, unknown> | undefined, (name) => has('mcp-server', name)),
    ),
  } as PLUGIN;
}

function pick<VALUE>(
  record: Record<string, VALUE> | undefined,
  wanted: (name: string) => boolean,
): Record<string, VALUE> | undefined {
  return record && Object.fromEntries(Object.entries(record).filter(([name]) => wanted(name)));
}

function nonEmpty<KEY extends string>(
  key: KEY,
  value: object | undefined,
): Partial<Record<KEY, object>> {
  return value !== undefined && Object.keys(value).length > 0
    ? ({ [key]: value } as Record<KEY, object>)
    : {};
}
