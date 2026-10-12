import type { ToolRequest } from '../definitions/policy.js';
import type { ToolKind } from '../definitions/tools.js';

import { commandOf, pathsOf, toolKindOf } from '../utils/requests.js';

/** A tool call as an approval request shows it: what it does, and on what. */
export interface ToolCallSummary {
  kind: ToolKind;
  /** "Run a command", "Edit a file", or the tool's name. */
  title: string;
  /** The command, the files, or the input in short. */
  detail: string;
}

const MAX_DETAIL = 400;

const short = (text: string): string =>
  text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL - 1)}…` : text;

/** What a tool call does, in a few words, for a person to approve or deny it. */
export function describeToolCall({ toolName, input }: ToolRequest): ToolCallSummary {
  const kind = toolKindOf(toolName);
  if (kind === 'command') {
    return { kind, title: 'Run a command', detail: short(commandOf(toolName, input) ?? '') };
  }
  if (kind === 'edit') {
    const paths = pathsOf(input);
    const verb = /^write$/i.test(toolName) ? 'Write' : 'Edit';
    return {
      kind,
      title: `${verb} ${paths.length > 1 ? 'files' : 'a file'}`,
      detail: short(paths.join(', ')),
    };
  }
  const detail =
    input === undefined ? '' : typeof input === 'string' ? input : JSON.stringify(input);
  return { kind, title: toolName, detail: short(detail) };
}
