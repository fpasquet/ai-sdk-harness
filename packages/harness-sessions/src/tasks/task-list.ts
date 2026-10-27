import type { UIMessage } from 'ai';

import { getToolName, isToolUIPart } from 'ai';

/** Where a task of the agent's list stands. */
export type AgentTaskStatus = 'completed' | 'in-progress' | 'pending';

/** A task of the list the agent keeps while it works. */
export interface AgentTask {
  /** The id the agent refers to it by: Claude Code's own, or its place in the list it wrote. */
  id: string;
  /** What is to be done, in a few words. */
  subject: string;
  /** What is to be done, in detail, when the agent gave it. */
  description?: string;
  /** What the agent is doing while the task is in progress: "Running the tests". */
  activeForm?: string;
  status: AgentTaskStatus;
}

/** A call of one of the agent's tools, as its input arrived. */
export interface TaskToolCall {
  toolCallId?: string;
  toolName: string;
  input: unknown;
}

/** What a call of one of the agent's tools returned, or that it failed. */
export interface TaskToolResult {
  toolCallId: string;
  output?: unknown;
  /** The call failed or was denied: a task it was creating does not exist. */
  failed?: boolean;
}

/**
 * The task list of one session, followed call by call. Claude Code writes it whole (`TodoWrite`)
 * or task by task (`TaskCreate`, then `TaskUpdate` with the id the creation returned), and keeps
 * it from one turn to the next: follow the session's turns with the same list.
 */
export interface TaskList {
  /** Applies a call of one of the agent's tools; the whole list when it changed, else `undefined`. */
  call(call: TaskToolCall): AgentTask[] | undefined;
  /**
   * Applies what a call returned: the id a creation gave its task, or its failure, which takes the
   * task out. The whole list when it changed, else `undefined`.
   */
  result(result: TaskToolResult): AgentTask[] | undefined;
  /** The list as it stands. */
  readonly tasks: AgentTask[];
}

/**
 * The tools through which Claude Code keeps its task list. `TaskGet` and `TaskList` only read it,
 * but they are part of it: a client shows the list, not these calls.
 */
export const TASK_TOOL_NAMES: readonly string[] = [
  'TodoWrite',
  'TaskCreate',
  'TaskUpdate',
  'TaskGet',
  'TaskList',
];

/** Whether `toolName` is one of the tools through which the agent keeps its task list. */
export function isTaskToolName(toolName: string): boolean {
  return TASK_TOOL_NAMES.includes(toolName);
}

const STATUSES: Record<string, AgentTaskStatus> = {
  pending: 'pending',
  in_progress: 'in-progress',
  completed: 'completed',
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const stringOf = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

/** The optional fields of a task, those of `input` that are strings. */
function detailsOf(input: Record<string, unknown>): Pick<AgentTask, 'activeForm' | 'description'> {
  const description = stringOf(input.description);
  const activeForm = stringOf(input.activeForm);
  return {
    ...(description !== undefined && { description }),
    ...(activeForm !== undefined && { activeForm }),
  };
}

/** The id of a created task: in the output Claude Code gives the tool, else in its text. */
function createdId(output: unknown): string | undefined {
  if (isRecord(output) && isRecord(output.task)) {
    const id = output.task.id;
    if (typeof id === 'string' || typeof id === 'number') return String(id);
  }
  const text = typeof output === 'string' ? output : JSON.stringify(output ?? null);
  return /Task #(\d+)/.exec(text)?.[1];
}

interface Entry {
  task: AgentTask;
  /** The call that creates it, until its output gave the task its id. */
  creation?: string;
}

/** The list of {@link createTaskList}. */
class SessionTaskList implements TaskList {
  private entries: Entry[] = [];
  // Claude Code numbers the tasks of a list in the order they are created: that number stands
  // for the id until the creation's output gives it.
  private created = 0;

  get tasks(): AgentTask[] {
    return this.entries.map(({ task }) => ({ ...task }));
  }

  call({ toolCallId, toolName, input }: TaskToolCall): AgentTask[] | undefined {
    if (!isRecord(input)) return undefined;
    if (toolName === 'TodoWrite') return this.write(input);
    if (toolName === 'TaskCreate') return this.create(input, toolCallId);
    if (toolName === 'TaskUpdate') return this.update(input);
    return undefined;
  }

  result({ toolCallId, output, failed }: TaskToolResult): AgentTask[] | undefined {
    const entry = this.entries.find(({ creation }) => creation === toolCallId);
    if (entry === undefined) return undefined;
    delete entry.creation;
    if (failed === true) {
      this.entries = this.entries.filter((other) => other !== entry);
      return this.tasks;
    }
    const id = createdId(output);
    if (id === undefined || id === entry.task.id) return undefined;
    entry.task = { ...entry.task, id };
    return this.tasks;
  }

  private write(input: Record<string, unknown>): AgentTask[] | undefined {
    if (!Array.isArray(input.todos)) return undefined;
    this.entries = input.todos.flatMap((todo: unknown, index): Entry[] => {
      if (!isRecord(todo)) return [];
      const subject = stringOf(todo.content);
      const status = STATUSES[stringOf(todo.status) ?? ''];
      if (subject === undefined || status === undefined) return [];
      return [{ task: { id: String(index + 1), subject, ...detailsOf(todo), status } }];
    });
    return this.tasks;
  }

  private create(
    input: Record<string, unknown>,
    toolCallId: string | undefined,
  ): AgentTask[] | undefined {
    const subject = stringOf(input.subject);
    if (subject === undefined) return undefined;
    this.created += 1;
    this.entries.push({
      task: { id: String(this.created), subject, ...detailsOf(input), status: 'pending' },
      ...(toolCallId !== undefined && { creation: toolCallId }),
    });
    return this.tasks;
  }

  private update(input: Record<string, unknown>): AgentTask[] | undefined {
    const entry = this.entries.find(({ task }) => task.id === String(input.taskId));
    if (entry === undefined) return undefined;
    if (input.status === 'deleted') {
      this.entries = this.entries.filter((other) => other !== entry);
      return this.tasks;
    }
    const subject = stringOf(input.subject);
    const status = STATUSES[stringOf(input.status) ?? ''];
    entry.task = {
      ...entry.task,
      ...(subject !== undefined && { subject }),
      ...detailsOf(input),
      ...(status !== undefined && { status }),
    };
    return this.tasks;
  }
}

/** A new, empty task list, for one session. */
export function createTaskList(): TaskList {
  return new SessionTaskList();
}

/**
 * The agent's task list as a conversation leaves it: its calls of `TodoWrite`, `TaskCreate` and
 * `TaskUpdate` replayed in order, over every turn. Empty when the agent kept none.
 */
export function tasksOf(messages: readonly UIMessage[]): AgentTask[] {
  const list = createTaskList();
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const part of message.parts) {
      if (!isToolUIPart(part)) continue;
      const toolName = getToolName(part);
      // Still streaming in: its input is not whole yet.
      if (!isTaskToolName(toolName) || part.state === 'input-streaming') continue;
      list.call({ toolCallId: part.toolCallId, toolName, input: part.input });
      if (part.state === 'output-available') {
        list.result({ toolCallId: part.toolCallId, output: part.output });
      } else if (part.state === 'output-error' || part.state === 'output-denied') {
        list.result({ toolCallId: part.toolCallId, failed: true });
      }
    }
  }
  return list.tasks;
}
