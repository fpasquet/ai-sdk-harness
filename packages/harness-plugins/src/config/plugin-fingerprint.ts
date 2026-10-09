import { createHash } from 'node:crypto';

/**
 * A short hash of stored plugins — manifests, or any JSON —, the same whatever the order of their
 * keys. Key your built agents by it: an edit in the back office changes it, and the next session
 * builds a new agent with the plugins as they stand.
 */
export function pluginFingerprint(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex').slice(0, 16);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
