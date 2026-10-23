import type { Tool } from '@ai-sdk/provider-utils';

import type { ItemKind } from '../config/item-schema.js';
import type { PluginHosts } from '../config/plugin-hosts.js';
import type { ResolvedPlugins, ResolveOptions } from '../config/resolve-plugins.js';
import type { Plugin, ToolDefinition } from '../definitions/plugin.js';
import type { PluginIssue } from '../errors/invalid-plugin-error.js';
import type { CatalogDescription } from './describe-catalog.js';
import type { Deselection, SelectedEntry, SelectOptions } from './selection.js';

import { defineItem, definePlugin } from '../config/define.js';
import { plainInputSchema } from '../config/input-schema.js';
import { pluginOfItem } from '../config/item-schema.js';
import { pluginFingerprint } from '../config/plugin-fingerprint.js';
import { pluginHosts } from '../config/plugin-hosts.js';
import { isToolDefinition } from '../config/plugin-schema.js';
import { resolveChecked } from '../config/resolve-plugins.js';
import { InvalidPluginError } from '../errors/invalid-plugin-error.js';
import { filterPlugin, itemKey, itemsOf, requiresAt } from './catalog-items.js';
import { describeCatalog } from './describe-catalog.js';
import { deselect, expandSelection, explainSelection } from './selection.js';

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
  /**
   * The ids of what it needs, selected with it. For a plugin, its items, then what it requires
   * besides them — whose ids do not start with `<plugin>/`.
   */
  requires: string[];
}

/**
 * A marketplace: plugins and items, from code and from your database, each with an id an agent's
 * selection keeps. Selecting a plugin selects all its items and what the plugin requires;
 * selecting an item selects what it requires.
 */
export interface Catalog {
  /** Every plugin and item, in the order given: what a back office lists. */
  entries(): CatalogEntry[];
  /** The public description of every plugin and item: what a marketplace page shows. */
  describe(): Promise<CatalogDescription>;
  /**
   * The ids `selection` comes to once what its plugins and items require is added, in catalog
   * order.
   */
  expand(selection: readonly string[], options?: SelectOptions): string[];
  /**
   * Each id `selection` comes to, in catalog order, chosen or not, and the ids that require it:
   * what a back office shows as "required by", and keeps selected while they are.
   */
  explain(selection: readonly string[], options?: SelectOptions): SelectedEntry[];
  /**
   * `selection` without `id` — an item of a plugin chosen whole leaves its other items chosen —,
   * and what still brings `id`: refuse the change while anything does.
   */
  deselect(selection: readonly string[], id: string): Deselection;
  /**
   * What the catalog could not meet once `value` — a plugin, or an item on its own for
   * `kind: 'item'` — takes the place of the one of its name, or joins it: an issue at each of its
   * `requires` naming what the catalog does not have, as `createCatalog()` would refuse it, then
   * one at the root for each `requires` elsewhere it would no longer meet — an item it removes
   * that another requires. Empty when it can be saved. What a back office checks before it saves
   * an edit; throws {@link InvalidPluginError} for what `definePlugin()` or `defineItem()`
   * refuses.
   */
  check(value: unknown, kind?: 'item' | 'plugin'): PluginIssue[];
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
  /**
   * The hosts `selection` reaches, from the sandbox and from your server, what it requires
   * included: the `hosts` of `resolve()`, without resolving anything — what a sandbox's network
   * policy is built from before the sandbox, or the agent, exists.
   */
  hosts(selection: readonly string[], options?: SelectOptions): PluginHosts;
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
 * one, two of one name, or a `requires` naming what the catalog does not have — its `issues` at
 * each such `requires`, within the plugin or the item. `catalog.check()` tells the same of an edit
 * before it is saved.
 */
export function createCatalog(sources: CatalogSources): Catalog {
  const all: Source[] = [
    ...(sources.plugins ?? []).map((value) => sourceOf(value, false)),
    ...(sources.items ?? []).map((value) => sourceOf(value, true)),
  ];
  const entries = entriesOf(all);
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  checkRequires(all, byId);
  resolveRequires(entries, byId);
  const expand = (selection: readonly string[], options?: SelectOptions): string[] =>
    expandSelection(entries, selection, options);
  const selected = (selection: readonly string[], options?: SelectOptions) =>
    selectedPlugins(all, new Set(expand(selection, options)));
  return {
    entries: () => entries.map((entry) => ({ ...entry, requires: [...entry.requires] })),
    describe: () => describeCatalog(all, entries, sources.tools ?? {}),
    expand,
    explain: (selection, options) => explainSelection(entries, selection, options),
    deselect: (selection, id) => deselect(entries, selection, id),
    check: (value, kind = 'plugin') => checkEdit(all, sourceOf(value, kind === 'item')),
    resolve: (selection, options = {}) =>
      resolveChecked(selected(selection, options), { ...options, tools: sources.tools }),
    fingerprint: (selection, options) =>
      pluginFingerprint({
        ids: expand(selection, options),
        plugins: selected(selection, options).map(fingerprintable),
      }),
    hosts: (selection, options) => pluginHosts(selected(selection, options)),
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
      // What the plugin requires is outside it: an id of the whole catalog, as it is written.
      const requires = [
        ...itemsOf(source.plugin).map((item) => idOf(source, item)),
        ...(source.plugin.requires ?? []),
      ];
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

/** A plugin, or an item on its own as the plugin it resolves to, checked. */
function sourceOf(value: unknown, single: boolean): Source {
  const plugin = single ? pluginOfItem(defineItem(value)) : definePlugin(value);
  return { name: plugin.name, single, plugin };
}

/** What an error names a source by: its plugin's name, or `<kind>:<name>` for an item. */
const labelOf = (source: Source): string | undefined =>
  source.single ? itemsOf(source.plugin).map(itemKey)[0] : source.name;

/** Each `requires` of `source` the catalog does not have, at its path within the source. */
function unmetRequires(
  source: Source,
  byId: Map<string, CatalogEntry>,
): { path: (number | string)[]; ref: string }[] {
  const met = ({ ref, ofPlugin }: { ref: string; ofPlugin: boolean }): boolean => {
    if (source.single || ofPlugin) return byId.has(ref);
    const id = refOf(source, ref);
    return byId.has(id) || byId.has(id.replace(/^[^/]+\//, ''));
  };
  return requiresAt(source.plugin)
    .filter((required) => !met(required))
    .map(({ path, ref }) => ({
      // An item on its own: within it, not within the plugin it resolves to.
      path: source.single ? path.slice(2) : path,
      ref,
    }));
}

/** An unmet `requires`, at its path. */
const missing = ({ path, ref }: { path: (number | string)[]; ref: string }): PluginIssue => ({
  path,
  message: `names ${ref}, which the catalog does not have`,
});

/** Each source's `requires` the catalog has: the first source naming any it lacks throws. */
function checkRequires(sources: readonly Source[], byId: Map<string, CatalogEntry>): void {
  for (const source of sources) {
    const issues = unmetRequires(source, byId).map(missing);
    const first = issues[0];
    if (first === undefined) continue;
    const more = issues.length > 1 ? ` (and ${issues.length - 1} more)` : '';
    throw new InvalidPluginError(
      `${first.path.join('.')}: ${first.message}${more}.`,
      labelOf(source),
      issues,
    );
  }
}

/**
 * What `sources` could not meet with `edited` in place of the one of its name: its own unmet
 * `requires`, then, at its root, each of the others' it would leave unmet.
 */
function checkEdit(sources: readonly Source[], edited: Source): PluginIssue[] {
  const others = sources.filter((source) => source.name !== edited.name);
  const byId = new Map(entriesOf([...others, edited]).map((entry) => [entry.id, entry]));
  const own = unmetRequires(edited, byId).map(missing);
  const broken = others.flatMap((source) =>
    unmetRequires(source, byId).map(({ ref }) => ({
      path: [],
      message: `${source.single ? labelOf(source) : `plugin:${source.name}`} requires ${ref}, which it would no longer have`,
    })),
  );
  return [...own, ...broken];
}

/**
 * Each item's `requires` as an id: `<kind>:<name>` names an item of its plugin first, then one on
 * its own. Every one is met, `createCatalog()` has checked: what is not an id already is one on
 * its own.
 */
function resolveRequires(entries: readonly CatalogEntry[], byId: Map<string, CatalogEntry>): void {
  for (const entry of entries) {
    for (const [index, ref] of entry.requires.entries()) {
      if (byId.has(ref)) continue;
      entry.requires[index] = ref.replace(/^[^/]+\//, '');
    }
  }
}

/**
 * Each source with items selected, filtered down to them. A plugin leaves without its `requires`:
 * what it requires is selected beside it, each the item it is, or not at all when one of its items
 * is selected alone.
 */
function selectedPlugins(sources: readonly Source[], ids: ReadonlySet<string>): Plugin[] {
  const plugins: Plugin[] = [];
  for (const source of sources) {
    const keep = new Set(
      itemsOf(source.plugin)
        .filter((item) => ids.has(idOf(source, item)))
        .map(itemKey),
    );
    if (keep.size === 0) continue;
    const { requires: _requires, ...plugin } = filterPlugin(source.plugin, keep);
    plugins.push(plugin);
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
