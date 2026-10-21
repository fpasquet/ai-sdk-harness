import type { CatalogEntry } from './catalog.js';
import type { CatalogDescription } from './describe-catalog.js';

import { InvalidPluginError } from '../errors/invalid-plugin-error.js';

export interface SelectOptions {
  /**
   * Skip the ids the catalog does not have rather than throw: a selection kept in a database may
   * name something removed since.
   */
  ignoreUnknown?: boolean;
}

/** One id a selection comes to, and why it is there. */
export interface SelectedEntry {
  id: string;
  /** Chosen itself: in the selection. */
  chosen: boolean;
  /**
   * The ids, among those the selection comes to, that require it: the plugin of an item, a
   * plugin that requires it besides its items, an item that requires it. Empty for an id only
   * chosen.
   */
  requiredBy: string[];
}

/** A selection once an id is taken out of it. */
export interface Deselection {
  /**
   * The selection without the id: dropped when chosen, or, for an item of a plugin chosen whole,
   * the plugin replaced by its other items. The rest stays in order.
   */
  selection: string[];
  /**
   * The ids that still bring it: it stays selected while they are. Empty when it is gone.
   */
  requiredBy: string[];
  /**
   * Every id the selection no longer comes to, in catalog order: the id when it is gone, and
   * what only it brought — or, for an item of a plugin chosen whole, what the plugin required
   * besides its items. What a back office says the change takes away.
   */
  removed: string[];
}

/**
 * The ids `selection` comes to once what its plugins and items require is added, in the order of
 * `entries`.
 */
export function expandSelection(
  entries: readonly CatalogEntry[],
  selection: readonly string[],
  { ignoreUnknown = false }: SelectOptions = {},
): string[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
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

/**
 * Each id `selection` comes to, in the order of `entries`, with what brings it: what a form shows
 * as "required by", and locks while it is.
 */
export function explainSelection(
  entries: readonly CatalogEntry[],
  selection: readonly string[],
  options?: SelectOptions,
): SelectedEntry[] {
  const ids = expandSelection(entries, selection, options);
  const present = new Set(ids);
  const chosen = new Set(selection);
  const requirers = new Map<string, string[]>();
  for (const entry of entries) {
    if (!present.has(entry.id)) continue;
    for (const required of new Set(entry.requires)) {
      if (required === entry.id) continue;
      requirers.set(required, [...(requirers.get(required) ?? []), entry.id]);
    }
  }
  return ids.map((id) => ({ id, chosen: chosen.has(id), requiredBy: requirers.get(id) ?? [] }));
}

/**
 * `selection` without `id`. An item of a plugin chosen whole leaves the plugin's other items
 * chosen, each on its own: the plugin no longer brings what it requires besides them. What still
 * brings `id` is in `requiredBy`: refuse the change, or keep it, knowing `id` stays. It never
 * throws: an id the catalog no longer has stays in the selection, as it was.
 */
export function deselect(
  entries: readonly CatalogEntry[],
  selection: readonly string[],
  id: string,
): Deselection {
  const plugin = entries.find((entry) => entry.id === id)?.plugin;
  const next = selection.includes(id)
    ? selection.filter((other) => other !== id)
    : selection.flatMap((other) =>
        plugin !== undefined && other === `plugin:${plugin}`
          ? entries
              .filter(
                (entry) =>
                  entry.plugin === plugin && entry.id !== id && !selection.includes(entry.id),
              )
              .map((entry) => entry.id)
          : [other],
      );
  const explained = explainSelection(entries, next, { ignoreUnknown: true });
  const kept = new Set(explained.map((entry) => entry.id));
  return {
    selection: next,
    requiredBy: explained.find((entry) => entry.id === id)?.requiredBy ?? [],
    removed: expandSelection(entries, selection, { ignoreUnknown: true }).filter(
      (other) => !kept.has(other),
    ),
  };
}

/**
 * The entries `description` stands for, in catalog order: a plugin before its items, the
 * plugins before the items on their own, as `createCatalog()` orders them.
 */
export function entriesOfDescription({ items, plugins }: CatalogDescription): CatalogEntry[] {
  const entries: CatalogEntry[] = [];
  const placed = new Set<string>();
  let next = 0;
  /** The plugins up to `name` — through all of them without one —, each before its items. */
  const pluginsUpTo = (name?: string): void => {
    for (; next < plugins.length; next++) {
      const plugin = plugins[next];
      if (plugin === undefined) continue;
      placed.add(plugin.name);
      const own = items.filter((item) => item.plugin === plugin.name).map(({ id }) => id);
      entries.push({
        id: plugin.id,
        kind: 'plugin',
        name: plugin.name,
        requires: [...own, ...(plugin.requires ?? [])],
      });
      if (plugin.name === name) {
        next++;
        return;
      }
    }
  };
  for (const item of items) {
    if (item.plugin === undefined || !placed.has(item.plugin)) pluginsUpTo(item.plugin);
    entries.push({
      id: item.id,
      kind: item.kind,
      name: item.name,
      ...(item.plugin !== undefined && { plugin: item.plugin }),
      requires: [...item.requires],
    });
  }
  pluginsUpTo();
  return entries;
}
