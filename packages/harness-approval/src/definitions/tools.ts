/**
 * What a tool call does, as far as approvals go:
 *
 * - `command`: runs a shell command.
 * - `edit`: writes or edits files.
 * - `bookkeeping`: the agent's own notes, its to-do list or its plan: allowed unless the policy's
 *   `tools` say otherwise. Claude Code asks about them in `allow-reads`.
 * - `other`: anything else: a read, a web search, a tool of yours…
 */
export type ToolKind = 'bookkeeping' | 'command' | 'edit' | 'other';

/** The tools that run a shell command, by the name the stream gives them, and their input key. */
export const COMMAND_TOOLS: Readonly<Record<string, string>> = {
  bash: 'command',
  Bash: 'command',
  Monitor: 'command',
};

/** The tools that write files, by the name the stream gives them. */
export const EDIT_TOOLS: readonly string[] = [
  'write',
  'edit',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
];

/** The keys of a tool input that name the file it writes. */
export const PATH_KEYS: readonly string[] = ['file_path', 'notebook_path', 'path'];

/** The agent's own bookkeeping tools: Claude Code's to-do list, tasks and plan mode. */
export const BOOKKEEPING_TOOLS: readonly string[] = [
  'TodoWrite',
  'TaskCreate',
  'TaskUpdate',
  'TaskGet',
  'TaskList',
  'TaskOutput',
  'TaskStop',
  'EnterPlanMode',
  'ExitPlanMode',
];
