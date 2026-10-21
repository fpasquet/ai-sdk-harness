import { z } from 'zod/v4';

import type { Plugin } from '../definitions/plugin.js';
import type { Item, ItemKind } from './item-schema.js';

import { checkPlugin, hookNameOf } from '../definitions/plugin.js';
import { InvalidPluginError } from '../errors/invalid-plugin-error.js';
import { ITEM_KINDS, itemSchemas, pluginOfItem } from './item-schema.js';
import { inputSchemaField, pluginJsonSchemaSource, pluginSchema } from './plugin-schema.js';

/**
 * Checks a plugin and returns it as it is: one written in code, or configuration read from JSON
 * — a file, a database. Throws {@link InvalidPluginError} whose `issues` list every mistake by
 * field, two items of one name included.
 */
export function definePlugin<PLUGIN extends Plugin>(plugin: PLUGIN): PLUGIN;
export function definePlugin(config: unknown): Plugin;
export function definePlugin(config: unknown): Plugin {
  checked(pluginSchema, config, nameOf(config));
  const plugin = config as Plugin;
  checkNames(plugin, plugin.name);
  checkRequiresOutside(plugin);
  return plugin;
}

/**
 * Checks an item on its own — a tool, a skill, a command, a hook, a subagent or an MCP server —
 * against the schema of its `kind`, and returns it as it is. Throws {@link InvalidPluginError}
 * whose `issues` list every mistake by field.
 */
export function defineItem<ITEM extends Item>(item: ITEM): ITEM;
export function defineItem(config: unknown): Item;
export function defineItem(config: unknown): Item {
  const kind = (config as null | { kind?: unknown })?.kind;
  const label = typeof kind === 'string' ? `${kind}:${nameOf(config) ?? '?'}` : nameOf(config);
  if (!ITEM_KINDS.includes(kind as ItemKind)) {
    const message = `must be one of ${ITEM_KINDS.join(', ')}`;
    throw new InvalidPluginError(`kind: ${message}.`, label, [{ path: ['kind'], message }]);
  }
  checked(itemSchemas[kind as ItemKind], config, label);
  const item = config as Item;
  checkNames(pluginOfItem(item), label ?? item.name);
  return item;
}

/** The JSON Schema of a plugin written as JSON: what a form to edit one builds from. */
export function pluginJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(pluginJsonSchemaSource, JSON_ONLY);
}

/** The JSON Schema of an item of `kind`: what a form to edit one builds from. */
export function itemJsonSchema(kind: ItemKind): Record<string, unknown> {
  return z.toJSONSchema(itemSchemas[kind], JSON_ONLY);
}

/** What JSON can hold: a tool's input schema as a JSON Schema, not one written in code. */
const JSON_ONLY: Parameters<typeof z.toJSONSchema>[1] = {
  io: 'input',
  unrepresentable: 'any',
  override: ({ zodSchema, jsonSchema }) => {
    if (zodSchema !== inputSchemaField) return;
    for (const key of Object.keys(jsonSchema)) delete jsonSchema[key];
    Object.assign(jsonSchema, {
      type: 'object',
      description: 'The JSON Schema of the input: { "type": "object", "properties": … }',
      properties: { type: { const: 'object' } },
      required: ['type'],
    });
  },
};

/** Throws when `schema` refuses `value`, listing every mistake by field. */
function checked(schema: z.ZodType, value: unknown, label: string | undefined): void {
  const result = schema.safeParse(value);
  if (result.success) return;
  const issues = result.error.issues.map((issue) => ({
    path: issue.path.map((key) => (typeof key === 'symbol' ? String(key) : key)),
    // A key refused by a record carries the reason in an issue of its own.
    message:
      issue.code === 'invalid_key' ? (issue.issues[0]?.message ?? issue.message) : issue.message,
  }));
  const first = issues[0];
  const where = first === undefined || first.path.length === 0 ? '' : `${first.path.join('.')}: `;
  const more = issues.length > 1 ? ` (and ${issues.length - 1} more)` : '';
  throw new InvalidPluginError(`${where}${first?.message ?? 'not valid'}${more}.`, label, issues);
}

/** Two items of one name, which a schema cannot see. */
function checkNames(plugin: Plugin, label: string): void {
  try {
    checkPlugin(plugin);
  } catch (error) {
    const message = (error as InvalidPluginError).message.replace(/^Plugin "[^"]*": /, '');
    throw new InvalidPluginError(message, label, [{ path: [], message }]);
  }
}

/**
 * A plugin requires what is outside it: itself and its own items come with it. Checked here
 * rather than refined in the schema, which `pick()` and `omit()` would then refuse.
 */
function checkRequiresOutside(plugin: Plugin): void {
  const own = new Set([`plugin:${plugin.name}`, ...ownItemIds(plugin)]);
  const message = 'must name what is outside the plugin: the plugin and its own items come with it';
  const issues = (plugin.requires ?? []).flatMap((ref, index) =>
    own.has(ref) || ref.startsWith(`${plugin.name}/`)
      ? [{ path: ['requires', index], message }]
      : [],
  );
  const first = issues[0];
  if (first === undefined) return;
  const more = issues.length > 1 ? ` (and ${issues.length - 1} more)` : '';
  throw new InvalidPluginError(`${first.path.join('.')}: ${message}${more}.`, plugin.name, issues);
}

/** The ids a plugin's own items go by in a `requires`, `<kind>:<name>`, as in an item's. */
const ownItemIds = (plugin: Plugin): string[] => [
  ...Object.keys(plugin.tools ?? {}).map((name) => `tool:${name}`),
  ...(plugin.skills ?? []).map(({ name }) => `skill:${name}`),
  ...(plugin.rules ?? []).map(({ name }) => `rule:${name}`),
  ...(plugin.commands ?? []).map(({ name }) => `command:${name}`),
  ...(plugin.hooks ?? []).map((hook, index) => `hook:${hookNameOf(hook, index)}`),
  ...(plugin.subagents ?? []).map(({ name }) => `subagent:${name}`),
  ...Object.keys(plugin.mcpServers ?? {}).map((name) => `mcp-server:${name}`),
];

function nameOf(value: unknown): string | undefined {
  const name = (value as null | { name?: unknown })?.name;
  return typeof name === 'string' && name !== '' ? name : undefined;
}
