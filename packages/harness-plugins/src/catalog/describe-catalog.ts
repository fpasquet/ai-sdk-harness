import type { Tool } from '@ai-sdk/provider-utils';

import type { ItemKind } from '../config/item-schema.js';
import type { Plugin, PluginHookEvent } from '../definitions/plugin.js';
import type { PluginFeature } from '../runtimes/plugin-runtime.js';
import type { CatalogEntry } from './catalog.js';
import type { JsonSchema, PluginDescription } from './describe-plugin.js';

import { KNOWN_RUNTIMES } from '../runtimes/runtime-for.js';
import { describePlugin } from './describe-plugin.js';

/**
 * One item of a catalog, for the person choosing it: safe to send to a browser, like a
 * {@link PluginDescription}. What it holds besides its id depends on its kind.
 */
export interface CatalogItemDescription {
  id: string;
  kind: ItemKind;
  name: string;
  description: string;
  /** The plugin it belongs to; absent for an item on its own. */
  plugin?: string;
  /** The ids of what it needs, selected with it. */
  requires: string[];
  /** The runtimes this package knows that cannot take it (`codex` for a hook or a subagent). */
  unsupportedOn: string[];
  /** A tool: the JSON Schema of its input. */
  inputSchema?: JsonSchema;
  /** A rule: the files it is for, every file when absent. */
  paths?: string[];
  /** A command or a skill: what a user types, `/<name>`. */
  invocation?: string;
  argumentHint?: string;
  /** A hook: when it runs, and on which tools. */
  event?: PluginHookEvent;
  matcher?: string;
  /** A subagent: its tools and its model. */
  tools?: string[];
  model?: string;
  /** An MCP server: how it is reached, and where it runs. */
  type?: 'http' | 'stdio';
  runIn?: 'host' | 'sandbox';
}

/** Everything a catalog offers: its plugins, and every item, theirs and those on their own. */
export interface CatalogDescription {
  plugins: (PluginDescription & { id: string })[];
  items: CatalogItemDescription[];
}

interface DescribedSource {
  name: string;
  single: boolean;
  plugin: Plugin;
}

/** The public description of a catalog's `sources`, its entries giving their ids. */
export async function describeCatalog(
  sources: readonly DescribedSource[],
  entries: readonly CatalogEntry[],
  registered: Record<string, Tool>,
): Promise<CatalogDescription> {
  const described = await Promise.all(
    sources.map(async (source) => ({
      source,
      description: await describePlugin(source.plugin, registered),
    })),
  );
  const plugins = described
    .filter(({ source }) => !source.single)
    .map(({ source, description }) => ({ id: `plugin:${source.name}`, ...description }));
  const byKey = new Map(
    described.flatMap(({ source, description }) =>
      itemDescriptions(source, description).map((item) => [keyOf(source, item), item] as const),
    ),
  );
  const items = entries
    .filter((entry) => entry.kind !== 'plugin')
    .map((entry) => ({
      ...byKey.get(`${entry.plugin ?? ''}|${entry.kind}:${entry.name}`),
      ...entry,
    }))
    .map(({ plugin, ...item }) => ({ ...item, ...(plugin !== undefined && { plugin }) }));
  return { plugins, items: items as CatalogItemDescription[] };
}

type Partial = Omit<CatalogItemDescription, 'id' | 'plugin' | 'requires'>;

const keyOf = (source: DescribedSource, item: Partial): string =>
  `${source.single ? '' : source.name}|${item.kind}:${item.name}`;

/** The items of a described plugin, each with what its kind adds. */
function itemDescriptions(source: DescribedSource, plugin: PluginDescription): Partial[] {
  const unsupportedOn = (feature?: PluginFeature): string[] =>
    feature === undefined
      ? []
      : KNOWN_RUNTIMES.filter(({ supports }) => !supports[feature]).map(
          ({ harnessId }) => harnessId,
        );
  const hooks = source.plugin.hooks ?? [];
  const servers = source.plugin.mcpServers ?? {};
  return [
    ...plugin.tools.map(({ name, description, inputSchema }) => ({
      kind: 'tool' as const,
      name,
      description,
      inputSchema,
      unsupportedOn: [],
    })),
    ...plugin.skills.map((skill) => ({ kind: 'skill' as const, ...skill, unsupportedOn: [] })),
    ...plugin.rules.map((rule) => ({ kind: 'rule' as const, ...rule, unsupportedOn: [] })),
    ...plugin.commands.map((command) => ({
      kind: 'command' as const,
      ...command,
      unsupportedOn: [],
    })),
    ...plugin.hooks.map(({ name, event, matcher, description }) => ({
      kind: 'hook' as const,
      name,
      event,
      ...(matcher !== undefined && { matcher }),
      description: description ?? hooks.find((hook) => hook.name === name)?.description ?? '',
      unsupportedOn: unsupportedOn('hooks'),
    })),
    ...plugin.subagents.map((subagent) => ({
      kind: 'subagent' as const,
      ...subagent,
      unsupportedOn: unsupportedOn('subagents'),
    })),
    ...plugin.mcpServers.map(({ name, type }) => {
      const runIn = servers[name]?.runIn ?? 'host';
      return {
        kind: 'mcp-server' as const,
        name,
        description: source.single ? source.plugin.description : '',
        type,
        runIn,
        unsupportedOn: runIn === 'host' ? [] : unsupportedOn('mcpServers'),
      };
    }),
  ];
}
