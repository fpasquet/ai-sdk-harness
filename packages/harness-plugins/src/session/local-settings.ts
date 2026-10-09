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

/** The settings in `text`; an empty object for a missing file. Throws on a file that is not JSON. */
export function parseSettings(text: null | string, path: string): Record<string, unknown> {
  if (text === null || text.trim() === '') return {};
  try {
    return asRecord(JSON.parse(text));
  } catch {
    throw new Error(`${path} in the session's working directory is not valid JSON.`);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
