import type { UIMessage } from 'ai';

import { describe, expect, it } from 'vitest';

import { createTaskList, isTaskToolName, tasksOf } from './task-list.js';

describe('createTaskList', () => {
  it('takes the list TodoWrite writes, whole', () => {
    const list = createTaskList();
    list.call({
      toolName: 'TodoWrite',
      input: {
        todos: [
          { content: 'Read the code', status: 'completed', activeForm: 'Reading the code' },
          { content: 'Fix the bug', status: 'in_progress', activeForm: 'Fixing the bug' },
        ],
      },
    });
    const tasks = list.call({
      toolName: 'TodoWrite',
      input: { todos: [{ content: 'Run the tests', status: 'pending', activeForm: 'Running' }] },
    });

    expect(tasks).toEqual([
      { id: '1', subject: 'Run the tests', activeForm: 'Running', status: 'pending' },
    ]);
  });

  it('creates tasks one by one, with the id their creation returns', () => {
    const list = createTaskList();
    expect(
      list.call({
        toolCallId: 'c1',
        toolName: 'TaskCreate',
        input: { subject: 'Fix the bug', description: 'The null check', activeForm: 'Fixing' },
      }),
    ).toEqual([
      {
        id: '1',
        subject: 'Fix the bug',
        description: 'The null check',
        activeForm: 'Fixing',
        status: 'pending',
      },
    ]);

    expect(list.result({ toolCallId: 'c1', output: { task: { id: '7', subject: 'x' } } })).toEqual([
      expect.objectContaining({ id: '7' }),
    ]);
    list.call({ toolName: 'TaskUpdate', input: { taskId: '7', status: 'in_progress' } });

    expect(list.tasks).toEqual([expect.objectContaining({ id: '7', status: 'in-progress' })]);
  });

  it('reads the id in the text of the output, else numbers the tasks in creation order', () => {
    const list = createTaskList();
    list.call({ toolCallId: 'c1', toolName: 'TaskCreate', input: { subject: 'One' } });
    list.call({ toolCallId: 'c2', toolName: 'TaskCreate', input: { subject: 'Two' } });

    expect(list.result({ toolCallId: 'c1', output: 'Task #1 created successfully: One' })).toBe(
      undefined,
    );
    list.call({ toolName: 'TaskUpdate', input: { taskId: '2', status: 'completed' } });

    expect(list.tasks.map(({ id, status }) => [id, status])).toEqual([
      ['1', 'pending'],
      ['2', 'completed'],
    ]);
  });

  it('renames a task, and takes out a deleted one or one whose creation failed', () => {
    const list = createTaskList();
    list.call({ toolCallId: 'c1', toolName: 'TaskCreate', input: { subject: 'One' } });
    list.call({ toolCallId: 'c2', toolName: 'TaskCreate', input: { subject: 'Two' } });
    list.call({ toolCallId: 'c3', toolName: 'TaskCreate', input: { subject: 'Three' } });
    list.result({ toolCallId: 'c2', failed: true });
    list.call({ toolName: 'TaskUpdate', input: { taskId: '1', status: 'deleted' } });
    list.call({ toolName: 'TaskUpdate', input: { taskId: '3', subject: 'Third' } });

    expect(list.tasks).toEqual([{ id: '3', subject: 'Third', status: 'pending' }]);
  });

  it('changes nothing for a task it does not know, a read or another tool', () => {
    const list = createTaskList();

    expect(list.call({ toolName: 'TaskUpdate', input: { taskId: '9', status: 'completed' } })).toBe(
      undefined,
    );
    expect(list.call({ toolName: 'TaskList', input: {} })).toBe(undefined);
    expect(list.call({ toolName: 'Bash', input: { command: 'ls' } })).toBe(undefined);
    expect(list.result({ toolCallId: 'unknown', output: 'ok' })).toBe(undefined);
    expect(list.tasks).toEqual([]);
  });

  it('skips what it cannot read: an input, a todo or a task without its fields', () => {
    const list = createTaskList();

    expect(list.call({ toolName: 'TodoWrite', input: 'not an object' })).toBe(undefined);
    expect(list.call({ toolName: 'TodoWrite', input: { todos: 'none' } })).toBe(undefined);
    expect(list.call({ toolName: 'TaskCreate', input: { description: 'no subject' } })).toBe(
      undefined,
    );
    expect(
      list.call({
        toolName: 'TodoWrite',
        input: {
          todos: [
            'a todo as text',
            { status: 'pending' },
            { content: 'Unknown status', status: 'blocked' },
            { content: 'Kept', status: 'pending', description: 42 },
          ],
        },
      }),
    ).toEqual([{ id: '4', subject: 'Kept', status: 'pending' }]);
  });

  it('takes a numeric id from the output, and changes nothing when the id is the same', () => {
    const list = createTaskList();
    list.call({ toolCallId: 'c1', toolName: 'TaskCreate', input: { subject: 'One' } });
    list.call({ toolCallId: 'c2', toolName: 'TaskCreate', input: { subject: 'Two' } });
    list.call({ toolCallId: 'c3', toolName: 'TaskCreate', input: { subject: 'Three' } });

    expect(list.result({ toolCallId: 'c1', output: { task: { id: 11 } } })).toEqual([
      expect.objectContaining({ id: '11' }),
      expect.objectContaining({ id: '2' }),
      expect.objectContaining({ id: '3' }),
    ]);
    expect(list.result({ toolCallId: 'c2', output: { task: { id: '2' } } })).toBe(undefined);
    expect(list.result({ toolCallId: 'c3', output: null })).toBe(undefined);
    expect(list.tasks.map(({ id }) => id)).toEqual(['11', '2', '3']);
  });
});

describe('isTaskToolName', () => {
  it('knows the tools that keep the list, reads included', () => {
    expect(['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList'].every(isTaskToolName)).toBe(true);
    expect(isTaskToolName('TaskStop')).toBe(false);
  });
});

describe('tasksOf', () => {
  const turn = (id: string, parts: UIMessage['parts']): UIMessage => ({
    id,
    role: 'assistant',
    parts,
  });

  it('replays the calls of every turn, in order', () => {
    const messages: UIMessage[] = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Fix it' }] },
      turn('a1', [
        {
          type: 'dynamic-tool',
          toolName: 'TaskCreate',
          toolCallId: 'c1',
          state: 'output-available',
          input: { subject: 'Fix the bug' },
          output: { task: { id: '1' } },
        },
        {
          type: 'tool-TaskCreate',
          toolCallId: 'c2',
          state: 'output-available',
          input: { subject: 'Run the tests' },
          output: 'Task #2 created successfully: Run the tests',
        },
        {
          type: 'dynamic-tool',
          toolName: 'TaskUpdate',
          toolCallId: 'c3',
          state: 'output-available',
          input: { taskId: '1', status: 'completed' },
          output: 'Updated task #1 status',
        },
      ]),
      { id: 'u2', role: 'user', parts: [{ type: 'text', text: 'Go on' }] },
      turn('a2', [
        {
          type: 'dynamic-tool',
          toolName: 'TaskUpdate',
          toolCallId: 'c4',
          state: 'input-available',
          input: { taskId: '2', status: 'in_progress' },
        },
        {
          type: 'dynamic-tool',
          toolName: 'TaskCreate',
          toolCallId: 'c5',
          state: 'input-streaming',
          input: { subj: 'Wri' },
        },
      ]),
    ];

    expect(tasksOf(messages)).toEqual([
      { id: '1', subject: 'Fix the bug', status: 'completed' },
      { id: '2', subject: 'Run the tests', status: 'in-progress' },
    ]);
  });

  it('leaves out a task whose creation failed or was denied', () => {
    expect(
      tasksOf([
        turn('a1', [
          {
            type: 'dynamic-tool',
            toolName: 'TaskCreate',
            toolCallId: 'c1',
            state: 'output-error',
            input: { subject: 'One' },
            errorText: 'no',
          },
          {
            type: 'tool-TaskCreate',
            toolCallId: 'c2',
            state: 'output-denied',
            input: { subject: 'Two' },
            approval: { id: 'a', approved: false },
          },
        ]),
      ]),
    ).toEqual([]);
  });

  it('is empty when the agent kept no list', () => {
    expect(tasksOf([turn('a1', [{ type: 'text', text: 'Done.' }])])).toEqual([]);
  });
});
