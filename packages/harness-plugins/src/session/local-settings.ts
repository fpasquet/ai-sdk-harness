/**
 * The merge of the plugins' hooks into a settings file that may already hold settings of its own:
 * only the hook groups written the previous time are replaced, everything else is kept.
 */

/** A hook group, keyed by its event, as the manifest remembers it. */
export const groupKey = (event: string, group: unknown): string =>
  `${event}\u0000${JSON.stringify(group)}`;

/** The settings with the groups of `previous` taken out and `next`'s added, or `undefined` if empty. */
export function mergeHookGroups(
  settings: Record<string, unknown>,
  previous: ReadonlySet<string>,
  next: Readonly<Record<string, unknown[]>>,
): Record<string, unknown> | undefined {
  const hooks: Record<string, unknown[]> = {};
  for (const [event, groups] of Object.entries(asRecord(settings.hooks))) {
    const kept = (Array.isArray(groups) ? groups : []).filter(
      (group) => !previous.has(groupKey(event, group)),
    );
    if (kept.length > 0) hooks[event] = kept;
  }
  for (const [event, groups] of Object.entries(next)) {
    if (groups.length > 0) hooks[event] = [...(hooks[event] ?? []), ...groups];
  }
  const { hooks: _replaced, ...rest } = settings;
  const merged = Object.keys(hooks).length > 0 ? { ...rest, hooks } : rest;
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * The settings with the groups `taken` says are the plugins' taken out, then each group of `next`
 * its event does not have added; `added` keys those it added, not those the file already had of
 * its own. `settings` is `undefined` when nothing changed, an empty object when nothing is left.
 */
export function replaceHookGroups(
  settings: Record<string, unknown>,
  next: Readonly<Record<string, unknown[]>>,
  taken: (event: string, group: unknown) => boolean,
): { settings: Record<string, unknown> | undefined; added: string[] } {
  const hooks: Record<string, unknown> = {};
  for (const [event, groups] of Object.entries(asRecord(settings.hooks))) {
    // What the plugins cannot have written stays as it is.
    if (!Array.isArray(groups) || groups.length === 0) hooks[event] = groups;
    else {
      const kept = groups.filter((group) => !taken(event, group));
      if (kept.length > 0) hooks[event] = kept;
    }
  }
  const added = Object.entries(next).flatMap(([event, groups]) =>
    groups.flatMap((group) => addGroup(hooks, event, group)),
  );
  const { hooks: _replaced, ...rest } = settings;
  const merged = Object.keys(hooks).length > 0 ? { ...rest, hooks } : rest;
  const changed = JSON.stringify(merged) !== JSON.stringify(settings);
  return { settings: changed ? merged : undefined, added };
}

/** Adds `group` under `event` unless it is there already; its key when it was added. */
function addGroup(hooks: Record<string, unknown>, event: string, group: unknown): string[] {
  const key = groupKey(event, group);
  const existing = hooks[event];
  const present: unknown[] = Array.isArray(existing) ? (existing as unknown[]) : [];
  if (present.some((other) => groupKey(event, other) === key)) return [];
  hooks[event] = [...present, group];
  return [key];
}

/**
 * The settings in `text`, the file `where` says; an empty object for a missing file. Throws on a
 * file that is not JSON.
 */
export function parseSettings(text: null | string, where: string): Record<string, unknown> {
  if (text === null || text.trim() === '') return {};
  try {
    return asRecord(JSON.parse(text));
  } catch {
    throw new Error(`${where} is not valid JSON.`);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
