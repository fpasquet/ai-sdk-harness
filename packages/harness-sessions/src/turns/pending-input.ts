import type { ToolApprovalResponse, ToolResultPart, UIMessage } from 'ai';

import { getToolName, isToolUIPart } from 'ai';

import type { PendingInput } from '../definitions/session.js';

/** The answers that resume a turn awaiting input, as `HarnessAgent.continueStream()` takes them. */
export interface InputResponses {
  toolApprovalContinuations: ToolApprovalResponse[];
  toolResultContinuations: ToolResultPart[];
}

type ToolPart = Extract<UIMessage['parts'][number], { toolCallId: string }>;

const toolParts = (message: UIMessage | undefined): ToolPart[] =>
  (message?.parts ?? []).filter((part): part is ToolPart => isToolUIPart(part));

/** What the last message of the conversation waits for: approvals asked, tool calls unanswered. */
export function pendingInputOf(messages: readonly UIMessage[]): PendingInput {
  const last = messages.at(-1);
  const parts = last?.role === 'assistant' ? toolParts(last) : [];
  return {
    approvals: parts.flatMap((part) =>
      part.state === 'approval-requested'
        ? [
            {
              approvalId: part.approval.id,
              toolCallId: part.toolCallId,
              toolName: getToolName(part),
              input: part.input,
            },
          ]
        : [],
    ),
    toolCalls: parts.flatMap((part) =>
      part.state === 'input-available'
        ? [{ toolCallId: part.toolCallId, toolName: getToolName(part), input: part.input }]
        : [],
    ),
  };
}

/**
 * The answers to `pending` that `message` carries: the last assistant message as `useChat` sends
 * it back, once `addToolApprovalResponse()` or `addToolOutput()` filled it in.
 */
export function responsesFrom(message: UIMessage, pending: PendingInput): InputResponses {
  const parts = toolParts(message);
  const toolApprovalContinuations = pending.approvals.flatMap(({ approvalId }) => {
    const part = parts.find((candidate) => candidate.approval?.id === approvalId);
    if (part?.approval?.approved === undefined) return [];
    const { approved, reason } = part.approval;
    return [
      {
        type: 'tool-approval-response' as const,
        approvalId,
        approved,
        ...(reason !== undefined && { reason }),
      },
    ];
  });
  const toolResultContinuations = pending.toolCalls.flatMap(
    ({ toolCallId, toolName }): ToolResultPart[] => {
      const part = parts.find((candidate) => candidate.toolCallId === toolCallId);
      if (part?.state === 'output-available') {
        return [
          {
            type: 'tool-result',
            toolCallId,
            toolName,
            output: { type: 'json', value: part.output as never },
          },
        ];
      }
      if (part?.state === 'output-error') {
        return [
          {
            type: 'tool-result',
            toolCallId,
            toolName,
            output: { type: 'error-text', value: part.errorText },
          },
        ];
      }
      return [];
    },
  );
  return { toolApprovalContinuations, toolResultContinuations };
}

/** The value a tool result shows in the conversation. */
function shownOutput(output: ToolResultPart['output']): { error?: string; value?: unknown } {
  switch (output.type) {
    case 'error-text':
      return { error: output.value };
    case 'error-json':
      return { error: JSON.stringify(output.value) };
    case 'execution-denied':
      return { error: output.reason ?? 'The tool call was denied.' };
    default:
      return { value: output.value };
  }
}

/**
 * The conversation with `responses` written into the last message, as `useChat` shows them once
 * answered: what the turn continues from.
 */
export function withResponses(
  messages: readonly UIMessage[],
  responses: InputResponses,
): UIMessage[] {
  const approvals = new Map(
    responses.toolApprovalContinuations.map((response) => [response.approvalId, response]),
  );
  const results = new Map(
    responses.toolResultContinuations.map((result) => [result.toolCallId, result]),
  );
  return messages.map((message, index) =>
    index !== messages.length - 1
      ? message
      : {
          ...message,
          parts: message.parts.map((part) => {
            if (!isToolUIPart(part)) return part;
            const approval =
              part.state === 'approval-requested' ? approvals.get(part.approval.id) : undefined;
            if (approval !== undefined) {
              return {
                ...part,
                state: 'approval-responded',
                approval: {
                  ...part.approval,
                  approved: approval.approved,
                  ...(approval.reason !== undefined && { reason: approval.reason }),
                },
              } as typeof part;
            }
            const result =
              part.state === 'input-available' ? results.get(part.toolCallId) : undefined;
            if (result === undefined) return part;
            const { error, value } = shownOutput(result.output);
            return (
              error === undefined
                ? { ...part, state: 'output-available', output: value }
                : { ...part, state: 'output-error', errorText: error }
            ) as typeof part;
          }),
        },
  );
}

interface Questions {
  questions: { id: string; question: string; options?: { id: string; label: string }[] }[];
}
interface Answers {
  action: string;
  answers?: Record<string, { optionIds?: string[]; freeform?: string }>;
}

const isQuestions = (input: unknown): input is Questions =>
  Array.isArray((input as Partial<Questions> | undefined)?.questions);
const isAnswers = (output: unknown): output is Answers =>
  typeof (output as Partial<Answers> | undefined)?.action === 'string';

/**
 * The answers to the agent's questions, `askUserQuestions`, in words: the labels of the options
 * picked rather than their ids, which the agent no longer sees once its turn was lost.
 */
function answersOf(input: unknown, output: unknown): string | undefined {
  if (!isQuestions(input) || !isAnswers(output)) return undefined;
  if (output.answers === undefined) return `- I ${output.action} your questions.`;
  const { answers } = output;
  return input.questions
    .map(({ id, question, options = [] }) => {
      const answer = answers[id];
      const picked = (answer?.optionIds ?? []).map(
        (optionId) => options.find((option) => option.id === optionId)?.label ?? optionId,
      );
      const said = [...picked, ...(answer?.freeform ? [answer.freeform] : [])].join('; ');
      return `- ${question} — ${said || 'no answer'}`;
    })
    .join('\n');
}

/** A short form of a tool call's input, for a message. */
const inputOf = (input: unknown): string => {
  const text = typeof input === 'string' ? input : JSON.stringify(input);
  return text.length > 200 ? `${text.slice(0, 197)}...` : text;
};

/**
 * The answers to `pending` as a message the agent reads: what continues a turn that was lost with
 * a suspension, the harness session resumed without it.
 */
export function describeResponses(pending: PendingInput, responses: InputResponses): string {
  const approvals = responses.toolApprovalContinuations.map(({ approvalId, approved, reason }) => {
    const call = pending.approvals.find((approval) => approval.approvalId === approvalId);
    const what = call ? `${call.toolName} ${inputOf(call.input)}` : 'the tool call';
    const verdict = approved ? 'I approve' : 'I deny';
    return `- ${verdict} ${what}${reason === undefined ? '' : `: ${reason}`}`;
  });
  const results = responses.toolResultContinuations.map(({ toolCallId, toolName, output }) => {
    const call = pending.toolCalls.find((toolCall) => toolCall.toolCallId === toolCallId);
    const shown = shownOutput(output);
    const answers = shown.error === undefined ? answersOf(call?.input, shown.value) : undefined;
    if (answers !== undefined) return answers;
    const value = shown.error === undefined ? inputOf(shown.value) : `error: ${shown.error}`;
    return `- ${call?.toolName ?? toolName}: ${value}`;
  });
  return [
    'The session was suspended while you waited for my answers. Here they are; carry on from there:',
    ...approvals,
    ...results,
  ].join('\n');
}
