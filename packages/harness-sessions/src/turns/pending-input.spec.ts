import type { UIMessage } from 'ai';

import { describe, expect, it } from 'vitest';

import {
  describeResponses,
  pendingInputOf,
  responsesFrom,
  withResponses,
} from './pending-input.js';

const paused: UIMessage[] = [
  { id: 'u', role: 'user', parts: [{ type: 'text', text: 'go' }] },
  {
    id: 'a',
    role: 'assistant',
    parts: [
      { type: 'text', text: 'Let me check.' },
      {
        type: 'tool-Bash',
        toolCallId: 'call-1',
        state: 'approval-requested',
        input: { command: 'rm -rf build' },
        approval: { id: 'approval-1' },
      },
      {
        type: 'dynamic-tool',
        toolName: 'askUserQuestions',
        toolCallId: 'call-2',
        state: 'input-available',
        input: { questions: [] },
      },
      {
        type: 'tool-Read',
        toolCallId: 'call-3',
        state: 'output-available',
        input: { path: 'a' },
        output: 'done',
      },
    ],
  },
];

describe('pendingInputOf', () => {
  it('lists the approvals asked and the tool calls unanswered in the last message', () => {
    expect(pendingInputOf(paused)).toEqual({
      approvals: [
        {
          approvalId: 'approval-1',
          toolCallId: 'call-1',
          toolName: 'Bash',
          input: { command: 'rm -rf build' },
        },
      ],
      toolCalls: [{ toolCallId: 'call-2', toolName: 'askUserQuestions', input: { questions: [] } }],
    });
  });

  it('finds nothing when the last message is the user one', () => {
    expect(pendingInputOf(paused.slice(0, 1))).toEqual({ approvals: [], toolCalls: [] });
    expect(pendingInputOf([])).toEqual({ approvals: [], toolCalls: [] });
  });
});

describe('responsesFrom', () => {
  const pending = pendingInputOf(paused);

  it('reads the answers useChat filled in', () => {
    const answered: UIMessage = {
      ...paused[1]!,
      parts: [
        {
          type: 'tool-Bash',
          toolCallId: 'call-1',
          state: 'approval-responded',
          input: {},
          approval: { id: 'approval-1', approved: false, reason: 'too risky' },
        },
        {
          type: 'dynamic-tool',
          toolName: 'askUserQuestions',
          toolCallId: 'call-2',
          state: 'output-available',
          input: {},
          output: { answers: { q: 'yes' } },
        },
      ],
    };

    expect(responsesFrom(answered, pending)).toEqual({
      toolApprovalContinuations: [
        {
          type: 'tool-approval-response',
          approvalId: 'approval-1',
          approved: false,
          reason: 'too risky',
        },
      ],
      toolResultContinuations: [
        {
          type: 'tool-result',
          toolCallId: 'call-2',
          toolName: 'askUserQuestions',
          output: { type: 'json', value: { answers: { q: 'yes' } } },
        },
      ],
    });
  });

  it('reads a tool error as an error result, and leaves out what is not answered', () => {
    const answered: UIMessage = {
      ...paused[1]!,
      parts: [
        {
          type: 'dynamic-tool',
          toolName: 'askUserQuestions',
          toolCallId: 'call-2',
          state: 'output-error',
          input: {},
          errorText: 'declined',
        },
      ],
    };

    expect(responsesFrom(answered, pending)).toEqual({
      toolApprovalContinuations: [],
      toolResultContinuations: [
        {
          type: 'tool-result',
          toolCallId: 'call-2',
          toolName: 'askUserQuestions',
          output: { type: 'error-text', value: 'declined' },
        },
      ],
    });
    expect(responsesFrom(paused[1]!, pending)).toEqual({
      toolApprovalContinuations: [],
      toolResultContinuations: [],
    });
  });
});

describe('withResponses', () => {
  it('writes the answers into the last message, as useChat shows them', () => {
    const answered = withResponses(paused, {
      toolApprovalContinuations: [
        { type: 'tool-approval-response', approvalId: 'approval-1', approved: true, reason: 'ok' },
      ],
      toolResultContinuations: [
        {
          type: 'tool-result',
          toolCallId: 'call-2',
          toolName: 'askUserQuestions',
          output: { type: 'json', value: { answers: {} } },
        },
      ],
    });

    expect(answered[0]).toBe(paused[0]);
    expect(answered[1]?.parts.slice(1, 3)).toEqual([
      expect.objectContaining({
        state: 'approval-responded',
        approval: { id: 'approval-1', approved: true, reason: 'ok' },
      }),
      expect.objectContaining({ state: 'output-available', output: { answers: {} } }),
    ]);
  });

  it('shows an error result, or a denial, as a tool error', () => {
    const result = (output: unknown) =>
      withResponses(paused, {
        toolApprovalContinuations: [],
        toolResultContinuations: [
          {
            type: 'tool-result',
            toolCallId: 'call-2',
            toolName: 'askUserQuestions',
            output,
          } as never,
        ],
      })[1]?.parts[2];

    expect(result({ type: 'error-text', value: 'no' })).toMatchObject({
      state: 'output-error',
      errorText: 'no',
    });
    expect(result({ type: 'error-json', value: { code: 1 } })).toMatchObject({
      errorText: '{"code":1}',
    });
    expect(result({ type: 'execution-denied', reason: 'nope' })).toMatchObject({
      errorText: 'nope',
    });
    expect(result({ type: 'execution-denied' })).toMatchObject({
      errorText: 'The tool call was denied.',
    });
  });
});

describe('describeResponses', () => {
  it('tells the agent the answers to what it waited for', () => {
    const text = describeResponses(pendingInputOf(paused), {
      toolApprovalContinuations: [
        { type: 'tool-approval-response', approvalId: 'approval-1', approved: true },
        { type: 'tool-approval-response', approvalId: 'unknown', approved: false, reason: 'no' },
      ],
      toolResultContinuations: [
        {
          type: 'tool-result',
          toolCallId: 'call-2',
          toolName: 'askUserQuestions',
          output: { type: 'json', value: { answer: 'x'.repeat(300) } },
        },
        {
          type: 'tool-result',
          toolCallId: 'other',
          toolName: 'lookup',
          output: { type: 'error-text', value: 'failed' },
        },
      ],
    });

    expect(text.split('\n')).toEqual([
      'The session was suspended while you waited for my answers. Here they are; carry on from there:',
      '- I approve Bash {"command":"rm -rf build"}',
      '- I deny the tool call: no',
      `- askUserQuestions: ${`{"answer":"${'x'.repeat(300)}"}`.slice(0, 197)}...`,
      '- lookup: error: failed',
    ]);
  });

  it('says the answers to the questions of the agent in words', () => {
    const questions = {
      allowPartialAnswers: true,
      questions: [
        {
          id: 'lang',
          question: 'Which language?',
          options: [
            { id: 'ts', label: 'TypeScript' },
            { id: 'go', label: 'Go' },
          ],
        },
        { id: 'name', question: 'What name?' },
      ],
    };
    const pending = {
      approvals: [],
      toolCalls: [{ toolCallId: 'q', toolName: 'askUserQuestions', input: questions }],
    };
    const answer = (value: unknown) =>
      describeResponses(pending, {
        toolApprovalContinuations: [],
        toolResultContinuations: [
          {
            type: 'tool-result',
            toolCallId: 'q',
            toolName: 'askUserQuestions',
            output: { type: 'json', value: value as never },
          },
        ],
      })
        .split('\n')
        .slice(1);

    expect(
      answer({
        action: 'partially-answered',
        answers: { lang: { optionIds: ['ts', 'rust'], freeform: 'or Zig' } },
      }),
    ).toEqual(['- Which language? — TypeScript; rust; or Zig', '- What name? — no answer']);
    expect(answer({ action: 'declined' })).toEqual(['- I declined your questions.']);
  });
});
