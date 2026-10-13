/** A list, from one item or several. */
export const listOf = <T>(value: readonly T[] | T | undefined): readonly T[] =>
  value === undefined ? [] : Array.isArray(value) ? (value as readonly T[]) : [value as T];

/** Whether `text` contains `pattern`: a string as is, a RegExp as a pattern. */
export function contains(text: string, pattern: RegExp | string): boolean {
  if (typeof pattern === 'string') return text.includes(pattern);
  // A global RegExp keeps its position from one test to the next.
  pattern.lastIndex = 0;
  return pattern.test(text);
}

/** A string, cut to `max` characters, for a report. */
export function excerpt(text: string, max = 120): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

/** An error's message. */
export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
