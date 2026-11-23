import type { ToolRequest } from '../definitions/policy.js';
import type { ToolKind } from '../definitions/tools.js';

import { commandOf, fieldsOf, pathsOf, toolKindOf } from '../utils/requests.js';

/**
 * What a tool call does, as a key that holds no text: what an interface translates. `other` is
 * any tool the package does not know, shown by its name.
 */
export type ToolCallAction =
  | 'edit-file'
  | 'edit-files'
  | 'fetch-url'
  | 'find-files'
  | 'other'
  | 'read-file'
  | 'run-command'
  | 'search-files'
  | 'search-web'
  | 'write-file'
  | 'write-files';

/** The title of each action but `other`, in English: what {@link describeToolCall} gives. */
export const TOOL_CALL_TITLES: Readonly<Record<Exclude<ToolCallAction, 'other'>, string>> = {
  'run-command': 'Run a command',
  'write-file': 'Write a file',
  'write-files': 'Write files',
  'edit-file': 'Edit a file',
  'edit-files': 'Edit files',
  'read-file': 'Read a file',
  'find-files': 'Find files',
  'search-files': 'Search files',
  'fetch-url': 'Fetch a web page',
  'search-web': 'Search the web',
};

/** A tool call as an approval request shows it: what it does, and on what. */
export interface ToolCallSummary {
  /** What it does, as far as approvals go: see `ToolKind`. */
  kind: ToolKind;
  /** What it does, as a key with no text: the title of an interface in another language. */
  action: ToolCallAction;
  /** "Run a command", "Edit a file", or the tool's name: the title of its `action`. */
  title: string;
  /**
   * What it acts on: the command, the files, the pattern, the URL or the query; the input in short
   * for a tool the package does not know. Cut at `maxDetail` characters.
   */
  detail: string;
}

/** How {@link describeToolCall} words a tool call. */
export interface DescribeToolCallOptions {
  /**
   * The titles of the actions in your language, by action: an action left out keeps its English
   * title ({@link TOOL_CALL_TITLES}), and `other` is always the tool's name.
   */
  titles?: Partial<Record<Exclude<ToolCallAction, 'other'>, string>>;
  /**
   * The length the detail is cut at, an ellipsis included; `Infinity` keeps it whole.
   * @defaultValue `400`
   */
  maxDetail?: number;
}

/** The built-in tools read field by field, by their name in any case: `Read`, `read`, `webFetch`. */
const READ_TOOLS: readonly { name: RegExp; action: ToolCallAction; field: string }[] = [
  { name: /^read$/i, action: 'read-file', field: 'file_path' },
  { name: /^glob$/i, action: 'find-files', field: 'pattern' },
  { name: /^grep$/i, action: 'search-files', field: 'pattern' },
  { name: /^web_?fetch$/i, action: 'fetch-url', field: 'url' },
  { name: /^web_?search$/i, action: 'search-web', field: 'query' },
];

/** The action and detail of a tool call, before its title and its cut. */
interface ReadCall {
  kind: ToolKind;
  action: ToolCallAction;
  detail: string;
}

/** An edit: the files it writes. */
function readEdit({ toolName, input }: ToolRequest): ReadCall {
  const paths = pathsOf(input);
  const verb = /^write$/i.test(toolName) ? 'write' : 'edit';
  const files = paths.length > 1 ? 'files' : 'file';
  return { kind: 'edit', action: `${verb}-${files}`, detail: paths.join(', ') };
}

/** A built-in tool read field by field, when its input has the field. */
function readBuiltIn({ toolName, input }: ToolRequest, kind: ToolKind): ReadCall | undefined {
  const read = READ_TOOLS.find(({ name }) => name.test(toolName));
  if (read === undefined) return undefined;
  const value = fieldsOf(input)[read.field];
  return typeof value === 'string' ? { kind, action: read.action, detail: value } : undefined;
}

function readCall(request: ToolRequest): ReadCall {
  const { toolName, input } = request;
  const kind = toolKindOf(toolName);
  if (kind === 'command') {
    return { kind, action: 'run-command', detail: commandOf(toolName, input) ?? '' };
  }
  if (kind === 'edit') return readEdit(request);
  const builtIn = readBuiltIn(request, kind);
  if (builtIn !== undefined) return builtIn;
  // A tool of an MCP server, or of yours, that takes a command: read as one.
  const command = kind === 'other' ? commandOf(toolName, input) : undefined;
  if (command !== undefined) return { kind: 'command', action: 'run-command', detail: command };
  const detail =
    input === undefined ? '' : typeof input === 'string' ? input : JSON.stringify(input);
  return { kind, action: 'other', detail };
}

/**
 * What a tool call does, in a few words, for a person to approve or deny it: a command, the files
 * an edit writes, the file a read opens, the pattern of a search, the URL of a fetch, the query of
 * a web search. A tool the package does not know is shown by its name and its input, as a command
 * when its input carries a `command`. `action` says it with no text, for an interface that
 * translates; `titles` gives the titles in your language.
 */
export function describeToolCall(
  request: ToolRequest,
  { titles = {}, maxDetail = 400 }: DescribeToolCallOptions = {},
): ToolCallSummary {
  const { kind, action, detail } = readCall(request);
  const title =
    action === 'other' ? request.toolName : (titles[action] ?? TOOL_CALL_TITLES[action]);
  const cut =
    detail.length > maxDetail ? `${detail.slice(0, Math.max(0, maxDetail - 1))}…` : detail;
  return { kind, action, title, detail: cut };
}
