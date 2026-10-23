import { z } from 'zod/v4';

import type {
  Plugin,
  PluginCommand,
  PluginFile,
  PluginHook,
  PluginMcpServer,
  PluginNetwork,
  PluginRule,
  PluginSkill,
  PluginSubagent,
  ToolDefinition,
} from '../definitions/plugin.js';

import {
  commandFields,
  declaredPlaceholders,
  declaredRequired,
  declaredVariables,
  files,
  hookFields,
  mcpServerFields,
  network,
  NO_SECRET_IN_SANDBOX,
  noSecretInSandbox,
  ONE_HANDLER,
  oneHandler,
  ruleFields,
  serverName,
  skillFields,
  subagentFields,
  toolFields,
  toolName,
} from './plugin-schema.js';

/** The kinds of what a catalog offers, a plugin or one of its items. */
export const ITEM_KINDS = [
  'tool',
  'skill',
  'rule',
  'command',
  'hook',
  'subagent',
  'mcp-server',
] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

/**
 * One item on its own, rather than in a plugin: a tool, a skill, a rule, a command, a hook, a subagent or
 * an MCP server. Each is what it would be in a {@link Plugin}, with its `kind` and its `name`; a
 * tool is a {@link ToolDefinition}, one whose logic is code being one your application registers.
 * `network` lists the hosts it reaches that its definition does not show, as a plugin's does.
 */
export type Item = (
  | (PluginCommand & { kind: 'command' })
  | (PluginHook & {
      kind: 'hook';
      name: string;
      /** The scripts of the hook: `${PLUGIN_ROOT}` in its command points at them. */
      files?: PluginFile[];
    })
  | (PluginMcpServer & { kind: 'mcp-server'; name: string; description?: string })
  | (PluginRule & { kind: 'rule' })
  | (PluginSkill & { kind: 'skill' })
  | (PluginSubagent & { kind: 'subagent' })
  | (ToolDefinition & { kind: 'tool'; name: string })
) & { network?: PluginNetwork };

const kind = <KIND extends ItemKind>(value: KIND) => ({ kind: z.literal(value) });

/** The schema of each kind of {@link Item}: what `defineItem` checks, and a form builds from. */
export const itemSchemas = {
  tool: z.discriminatedUnion('type', [
    z
      .strictObject({ ...kind('tool'), name: toolName, ...toolFields['sandbox-command'], network })
      .superRefine(declaredRequired)
      .superRefine(declaredVariables),
    z
      .strictObject({ ...kind('tool'), name: toolName, ...toolFields.http, network })
      .superRefine(declaredPlaceholders)
      .superRefine(declaredRequired),
    z.strictObject({ ...kind('tool'), name: toolName, ...toolFields.registered, network }),
  ]),
  skill: z.strictObject({ ...kind('skill'), ...skillFields, network }),
  rule: z.strictObject({ ...kind('rule'), ...ruleFields, network }),
  command: z.strictObject({ ...kind('command'), ...commandFields, network }),
  hook: z
    .strictObject({
      ...kind('hook'),
      ...hookFields,
      name: skillFields.name,
      files: files.optional(),
      network,
    })
    .refine(oneHandler, ONE_HANDLER),
  subagent: z.strictObject({ ...kind('subagent'), ...subagentFields, network }),
  'mcp-server': z
    .discriminatedUnion('type', [
      z.strictObject({
        ...kind('mcp-server'),
        name: serverName,
        description: z.string().optional(),
        ...mcpServerFields.stdio,
        network,
      }),
      z.strictObject({
        ...kind('mcp-server'),
        name: serverName,
        description: z.string().optional(),
        ...mcpServerFields.http,
        network,
      }),
    ])
    .refine(noSecretInSandbox, NO_SECRET_IN_SANDBOX),
} satisfies Record<ItemKind, z.ZodType>;

/** Any {@link Item}, by its `kind`. */
export const itemSchema = z.union(Object.values(itemSchemas));

/**
 * The plugin an item on its own stands for once resolved: named after its kind and its name, with
 * the item as its only one — and the hook's files as its own, under its `${PLUGIN_ROOT}`, and its
 * `network` as the plugin's.
 */
export function pluginOfItem({ network, ...item }: Item): Plugin {
  const plugin = pluginOfBareItem(item);
  return network === undefined ? plugin : { ...plugin, network };
}

/** {@link pluginOfItem}, for an item without its `network`. */
function pluginOfBareItem(item: Item): Plugin {
  // Split rather than trimmed with a regular expression, which would run in quadratic time.
  const words = item.name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== '');
  const name = [item.kind, ...words].join('-');
  const description =
    'description' in item && item.description !== undefined ? item.description : '';
  if (item.kind === 'tool') {
    const { kind: _kind, name: tool, ...definition } = item;
    return { name, description, tools: { [tool]: definition } };
  }
  if (item.kind === 'mcp-server') {
    const { kind: _kind, name: server, description: _description, ...definition } = item;
    return { name, description, mcpServers: { [server]: definition } };
  }
  if (item.kind === 'hook') {
    const { kind: _kind, files: hookFiles, ...hook } = item;
    return { name, description, hooks: [hook], ...(hookFiles && { files: hookFiles }) };
  }
  // The others, in the list of their kind as they are.
  const { kind, ...rest } = item;
  return { name, description, [LISTS[kind]]: [rest] };
}

/** The list of a plugin each of the other kinds goes in. */
const LISTS = {
  command: 'commands',
  rule: 'rules',
  skill: 'skills',
  subagent: 'subagents',
} as const;
