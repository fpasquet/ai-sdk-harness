import type { ToolKind } from '../definitions/tools.js';

import { BOOKKEEPING_TOOLS, COMMAND_TOOLS, EDIT_TOOLS, PATH_KEYS } from '../definitions/tools.js';

/** What a tool call does, from its name: run a command, edit files, keep the agent's notes… */
export function toolKindOf(toolName: string): ToolKind {
  if (COMMAND_TOOLS[toolName] !== undefined) return 'command';
  if (EDIT_TOOLS.includes(toolName)) return 'edit';
  if (BOOKKEEPING_TOOLS.includes(toolName)) return 'bookkeeping';
  return 'other';
}

/** The input as an object: the stream gives it parsed, or as JSON. */
function fieldsOf(input: unknown): Record<string, unknown> {
  if (typeof input === 'string') {
    try {
      return fieldsOf(JSON.parse(input) as unknown);
    } catch {
      return {};
    }
  }
  return typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
}

/** The shell command a command tool runs, or `undefined` when its input carries none. */
export function commandOf(toolName: string, input: unknown): string | undefined {
  const value = fieldsOf(input)[COMMAND_TOOLS[toolName] ?? 'command'];
  if (typeof value === 'string') return value;
  return Array.isArray(value) && value.every((part) => typeof part === 'string')
    ? value.join(' ')
    : undefined;
}

/** A path without its `.` and `..` segments, so that `src/../.env` is read as `.env`. */
export function normalizePath(path: string): string {
  const absolute = path.startsWith('/');
  const kept: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') kept.pop();
    else kept.push(segment);
  }
  return `${absolute ? '/' : ''}${kept.join('/')}`;
}

/** The files an edit tool writes. */
export function pathsOf(input: unknown): string[] {
  const fields = fieldsOf(input);
  return PATH_KEYS.flatMap((key) => {
    const value = fields[key];
    return typeof value === 'string' && value !== '' ? [normalizePath(value)] : [];
  });
}
