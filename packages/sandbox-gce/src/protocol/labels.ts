/**
 * The labels a caller puts on a sandbox's machine and disk, as Compute Engine takes them: what a
 * billing export, or a budget, groups costs by.
 */

/** The prefix of the package's own labels, which no caller may set. */
export const RESERVED_LABEL_PREFIX = 'ai-sdk-';

/**
 * The most labels a caller sets: Compute Engine takes 64 on a resource, and the service puts some
 * of its own beside them.
 */
export const MAX_CALLER_LABELS = 56;

/** A key: a lowercase letter, then lowercase letters, digits, `_` or `-`, 63 at most. */
const KEY = /^[a-z][a-z0-9_-]{0,62}$/;

/** A value: lowercase letters, digits, `_` or `-`, 63 at most, empty allowed. */
const VALUE = /^[a-z0-9_-]{0,63}$/;

/**
 * Why Compute Engine, or the service, would refuse `labels`: `undefined` when it would not.
 * International characters, which Compute Engine accepts, are refused: a label is an identifier.
 */
export function labelsProblem(labels: Readonly<Record<string, unknown>>): string | undefined {
  const entries = Object.entries(labels);
  if (entries.length > MAX_CALLER_LABELS) {
    return `${entries.length} labels: ${MAX_CALLER_LABELS} at most.`;
  }
  for (const [key, value] of entries) {
    if (key.startsWith(RESERVED_LABEL_PREFIX)) {
      return `The label "${key}" starts with "${RESERVED_LABEL_PREFIX}", which the package keeps for its own.`;
    }
    if (!KEY.test(key)) {
      return `Invalid label key "${key}": a lowercase letter, then lowercase letters, digits, "_" or "-", 63 at most.`;
    }
    if (typeof value !== 'string' || !VALUE.test(value)) {
      return `Invalid value of the label "${key}": lowercase letters, digits, "_" or "-", 63 at most.`;
    }
  }
  return undefined;
}
