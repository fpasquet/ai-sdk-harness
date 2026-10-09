import type { Tool } from '@ai-sdk/provider-utils';

import type { ItemKind } from '../config/item-schema.js';
import type { ResolvedPlugins, ResolveOptions } from '../config/resolve-plugins.js';
import type { Plugin, ToolDefinition } from '../definitions/plugin.js';
import type { CatalogDescription } from './describe-catalog.js';

import { defineItem, definePlugin } from '../config/define.js';
import { plainInputSchema } from '../config/input-schema.js';
import { pluginOfItem } from '../config/item-schema.js';
import { pluginFingerprint } from '../config/plugin-fingerprint.js';
import { isToolDefinition } from '../config/plugin-schema.js';
import { resolveChecked } from '../config/resolve-plugins.js';
import { InvalidPluginError } from '../errors/invalid-plugin-error.js';
import { filterPlugin, itemKey, itemsOf } from './catalog-items.js';
import { describeCatalog } from './describe-catalog.js';

/** What a catalog offers: plugins and items, written in code or as configuration — JSON. */
export interface CatalogSources {
  /** Plugins, checked here as `definePlugin` checks them. */
  plugins?: readonly unknown[];
  /** Items on their own, checked here as `defineItem` checks them. */
  items?: readonly unknown[];
  /**
   * The tools your application implements, that configuration names with
   * `{ "type": "registered", "ref": "<key>" }`: what a tool whose logic is code is in JSON.
   */
  tools?: Record<string, Tool>;
}

/** One thing a catalog offers, and the id an agent's selection keeps of it. */
export interface CatalogEntry {
  /**
   * `plugin:<name>` for a plugin, `<plugin>/<kind>:<name>` for one of its items, `<kind>:<name>`
   * for an item on its own.
   */
  id: string;
  kind: 'plugin' | ItemKind;
  name: string;
  /** The plugin an item belongs to; absent for a plugin, and for an item on its own. */
  plugin?: string;
  /** The ids of what it needs, selected with it. */
  requires: string[];
}

export interface SelectOptions {
  /**
   * Skip the ids the catalog does not have rather than throw: a selection kept in a database may
   * name something removed since.
   */
  ignoreUnknown?: boolean;
}

/**
 * A marketplace: plugins and items, from code and from your database, each with an id an agent's
 * selection keeps. Selecting a plugin selects all its items; selecting an item selects what it
 * requires.
 */
export interface Catalog {
  /** Every plugin and item, in the order given: what a back office lists. */
  entries(): CatalogEntry[];
  /** The public description of every plugin and item: what a marketplace page shows. */
  describe(): Promise<CatalogDescription>;
  /** The ids `selection` comes to once what its items require is added, in catalog order. */
  expand(selection: readonly string[], options?: SelectOptions): string[];
  /**
   * The plugins `withPlugins` applies for `selection`: each plugin with the items selected, each
   * item on its own as a plugin of its own, resolved — their tool definitions built, their
   * secrets resolved, their MCP servers on the host connected. `close()` closes those clients.
   */
  resolve(
    selection: readonly string[],
    options?: ResolveOptions & SelectOptions,
  ): Promise<ResolvedPlugins>;
  /**
   * A short hash of what `selection` resolves to: key your built agents by it, and an edit of a
   * selected plugin or item builds a new one.
   */
  fingerprint(selection: readonly string[], options?: SelectOptions): string;
}

/** Where an entry comes from. */
interface Source {
  name: string;
  /** An item on its own: its ids name no plugin. */
  single: boolean;
  plugin: Plugin;
}

/**
 * A catalog of plugins and items, each checked. Throws {@link InvalidPluginError} for an invalid
 * one, two of one name, or a `requires` naming what the catalog does not have.
 */
export function createCatalog(sources: CatalogSources): Catalog {
  const all: Source[] = [
    ...(sources.plugins ?? []).map((value) => {
      const plugin = definePlugin(value);
      return { name: plugin.name, single: false, plugin };
    }),
    ...(sources.items ?? []).map((value) => {
      const plugin = pluginOfItem(defineItem(value));
      return { name: plugin.name, single: true, plugin };
    }),
  ];
  const entries = entriesOf(all);
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  checkRequires(entries, byId);
  const expand = (selection: readonly string[], options: SelectOptions = {}): string[] =>
    expandSelection(selection, { entries, byId }, options);
  const selected = (selection: readonly string[], options?: SelectOptions) =>
    selectedPlugins(all, new Set(expand(selection, options)));
  return {
    entries: () => entries.map((entry) => ({ ...entry, requires: [...entry.requires] })),
    describe: () => describeCatalog(all, entries, sources.tools ?? {}),
    expand,
    resolve: (selection, options = {}) =>
      resolveChecked(selected(selection, options), { ...options, tools: sources.tools }),
    fingerprint: (selection, options) =>
      pluginFingerprint({
        ids: expand(selection, options),
        plugins: selected(selection, options).map(fingerprintable),
      }),
  };
}

function entriesOf(sources: readonly Source[]): CatalogEntry[] {
  const seen = new Set<string>();
  const entries: CatalogEntry[] = [];
  for (const source of sources) {
    if (seen.has(source.name)) {
      throw new InvalidPluginError(
        'the catalog has two plugins or items of this name.',
        source.name,
      );
    }
    seen.add(source.name);
    if (!source.single) {
      const requires = itemsOf(source.plugin).map((item) => idOf(source, item));
      entries.push({ id: `plugin:${source.name}`, kind: 'plugin', name: source.name, requires });
    }
    for (const item of itemsOf(source.plugin)) {
      entries.push({
        id: idOf(source, item),
        kind: item.kind,
        name: item.name,
        ...(!source.single && { plugin: source.name }),
        requires: item.requires.map((ref) => refOf(source, ref)),
      });
    }
  }
  return entries;
}

const idOf = (source: Source, item: { kind: ItemKind; name: string }): string =>
  source.single ? itemKey(item) : `${source.name}/${itemKey(item)}`;

/** A `requires` entry as an id: within its plugin first, then in the whole catalog. */
const refOf = (source: Source, ref: string): string =>
  source.single || ref.includes('/') || ref.startsWith('plugin:') ? ref : `${source.name}/${ref}`;

function checkRequires(entries: readonly CatalogEntry[], byId: Map<string, CatalogEntry>): void {
  for (const entry of entries) {
    for (const [index, ref] of entry.requires.entries()) {
      if (byId.has(ref)) continue;
      const bare = ref.replace(/^[^/]+\//, '');
      if (entry.plugin !== undefined && byId.has(bare)) {
        entry.requires[index] = bare;
        continue;
      }
      throw new InvalidPluginError(
        `${entry.id} requires ${bare}, which the catalog does not have.`,
      );
    }
  }
}

function expandSelection(
  selection: readonly string[],
  { entries, byId }: { entries: readonly CatalogEntry[]; byId: Map<string, CatalogEntry> },
  { ignoreUnknown = false }: SelectOptions,
): string[] {
  const unknown = selection.filter((id) => !byId.has(id));
  if (unknown.length > 0 && !ignoreUnknown) {
    throw new InvalidPluginError(`The catalog has no ${unknown.join(', ')}.`);
  }
  const wanted = new Set<string>();
  const queue = selection.filter((id) => byId.has(id));
  for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
    if (wanted.has(id)) continue;
    wanted.add(id);
    queue.push(...(byId.get(id)?.requires ?? []));
  }
  return entries.map(({ id }) => id).filter((id) => wanted.has(id));
}

/** Each source with items selected, filtered down to them. */
function selectedPlugins(sources: readonly Source[], ids: ReadonlySet<string>): Plugin[] {
  const plugins: Plugin[] = [];
  for (const source of sources) {
    const keep = new Set(
      itemsOf(source.plugin)
        .filter((item) => ids.has(idOf(source, item)))
        .map(itemKey),
    );
    if (keep.size === 0) continue;
    plugins.push(filterPlugin(source.plugin, keep));
  }
  return plugins;
}

/**
 * A plugin as its fingerprint reads it: a tool of code stands for itself by its version — its
 * code is the application's, which a deployment changes —, a tool definition by its data.
 */
function fingerprintable({ tools, ...plugin }: Plugin): unknown {
  const written = Object.entries(tools ?? {}).map(([name, tool]): [string, unknown] => [
    name,
    isToolDefinition(tool) ? withPlainSchema(tool) : 'code',
  ]);
  return { ...plugin, tools: Object.fromEntries(written) };
}

/** A definition whose input schema is code, as its JSON Schema: what a fingerprint can read. */
function withPlainSchema(tool: ToolDefinition): unknown {
  if (!('inputSchema' in tool) || tool.inputSchema === undefined) return tool;
  return { ...tool, inputSchema: plainInputSchema(tool.inputSchema) ?? 'code' };
}
