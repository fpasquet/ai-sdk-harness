/**
 * `ai-sdk-harness-plugins/selection`: what a selection comes to, from a catalog's description
 * alone — the answers of `catalog.expand()`, `explain()` and `deselect()`, in a browser. It
 * imports nothing that runs on a server: a page that picks from a marketplace bundles it.
 */
import type { CatalogEntry } from './catalog/catalog.js';
import type { CatalogDescription } from './catalog/describe-catalog.js';
import type { Deselection, SelectedEntry, SelectOptions } from './catalog/selection.js';

import {
  deselect as deselectFrom,
  entriesOfDescription,
  expandSelection,
  explainSelection,
} from './catalog/selection.js';

export type { Deselection, SelectedEntry, SelectOptions } from './catalog/selection.js';

/** The entries of each description read so far: a page asks again at each render. */
const read = new WeakMap<CatalogDescription, CatalogEntry[]>();

function entriesOf(catalog: CatalogDescription): CatalogEntry[] {
  let entries = read.get(catalog);
  if (entries === undefined) {
    entries = entriesOfDescription(catalog);
    read.set(catalog, entries);
  }
  return entries;
}

/**
 * The ids `selection` comes to once what its plugins and items require is added, in catalog
 * order: `catalog.expand()`, from `catalog.describe()`.
 */
export function expand(
  catalog: CatalogDescription,
  selection: readonly string[],
  options?: SelectOptions,
): string[] {
  return expandSelection(entriesOf(catalog), selection, options);
}

/**
 * Each id `selection` comes to, chosen or not, and the ids that require it: `catalog.explain()`,
 * from `catalog.describe()`. What a picker shows as "required by", and locks while it is.
 */
export function explain(
  catalog: CatalogDescription,
  selection: readonly string[],
  options?: SelectOptions,
): SelectedEntry[] {
  return explainSelection(entriesOf(catalog), selection, options);
}

/**
 * `selection` without `id`, what still brings it and what the change takes away:
 * `catalog.deselect()`, from `catalog.describe()`.
 */
export function deselect(
  catalog: CatalogDescription,
  selection: readonly string[],
  id: string,
): Deselection {
  return deselectFrom(entriesOf(catalog), selection, id);
}
