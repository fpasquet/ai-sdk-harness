/** A list, from one item or several. */
export const listOf = <T>(value: readonly T[] | T | undefined): readonly T[] =>
  value === undefined ? [] : Array.isArray(value) ? (value as readonly T[]) : [value as T];

import type { TextPattern } from '../definitions/eval.js';

/** A pattern as a RegExp, or as the string it is. */
const compiled = (pattern: TextPattern): RegExp | string =>
  typeof pattern === 'string' || pattern instanceof RegExp
    ? pattern
    : new RegExp(pattern.regex, pattern.flags);

/** Whether `text` contains `pattern`: a string as it is, a RegExp as a pattern. */
export function contains(text: string, pattern: TextPattern): boolean {
  const found = compiled(pattern);
  if (typeof found === 'string') return text.includes(found);
  // A global RegExp keeps its position from one test to the next.
  found.lastIndex = 0;
  return found.test(text);
}

/** A pattern as a report names it: `README`, `/^feat/im`. */
export const patternName = (pattern: TextPattern): string => String(compiled(pattern));

/** A string, cut to `max` characters, for a report. */
export function excerpt(text: string, max = 120): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

/** An error's message. */
export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
