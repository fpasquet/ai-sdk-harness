import type { HarnessV1RequestTransformation } from '@ai-sdk/harness';

/** What a rule matches, comparable: its matchers, whatever the order of their keys. */
function matchKey({ match }: HarnessV1RequestTransformation): string {
  const sorted = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sorted);
    if (value === null || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, item]) => [name, sorted(item)]),
    );
  };
  return JSON.stringify(sorted(match));
}

/**
 * `existing`, then `added`, each added rule replacing one that matches exactly the same requests,
 * as the service does: a credential renewed for the same placeholder takes the place of the one
 * before.
 */
export function withTransformations(
  existing: readonly HarnessV1RequestTransformation[],
  added: readonly HarnessV1RequestTransformation[],
): HarnessV1RequestTransformation[] {
  const replaced = new Set(added.map(matchKey));
  const kept = existing.filter((transformation) => !replaced.has(matchKey(transformation)));
  const last = new Map(added.map((transformation) => [matchKey(transformation), transformation]));
  return [...kept, ...last.values()];
}
