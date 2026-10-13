import type { ToolApprovalResponse, UIMessage } from 'ai';

import { getToolName, isToolUIPart } from 'ai';

import type { EvalToolCall, EvalToolCallStatus } from '../definitions/eval.js';

type ToolPart = Extract<UIMessage['parts'][number], { toolCallId: string }>;

const toolPartsOf = (messages: readonly UIMessage[]): ToolPart[] =>
  messages.flatMap((message) =>
    message.role === 'assistant' ? message.parts.filter(isToolUIPart) : [],
  );

function statusOf(part: ToolPart): EvalToolCallStatus {
  switch (part.state) {
    case 'output-available':
      return part.preliminary === true ? 'pending' : 'completed';
    case 'output-error':
      return 'failed';
    case 'output-denied':
      return 'denied';
    case 'approval-responded':
      return part.approval.approved ? 'pending' : 'denied';
    default:
      return 'pending';
  }
}

/** The tool calls of the assistant messages, in order. */
export function toolCallsOf(messages: readonly UIMessage[], turn: number): EvalToolCall[] {
  return toolPartsOf(messages).map((part) => ({
    name: getToolName(part),
    input: part.input,
    ...(part.state === 'output-available' && { output: part.output }),
    ...(part.state === 'output-error' && { error: part.errorText }),
    status: statusOf(part),
    turn,
  }));
}

/** The text of the assistant messages, their text parts one after the other. */
export function textOf(messages: readonly UIMessage[]): string {
  return messages
    .filter((message) => message.role === 'assistant')
    .flatMap((message) =>
      message.parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])),
    )
    .join('\n')
    .trim();
}

/** The approvals the last message waits for. */
export function pendingApprovalsOf(messages: readonly UIMessage[]): string[] {
  const last = messages.at(-1);
  if (last === undefined) return [];
  return toolPartsOf([last]).flatMap((part) =>
    part.state === 'approval-requested' ? [part.approval.id] : [],
  );
}

/**
 * The conversation with the answers given: the parts that waited for them marked as answered, so
 * that the stream that continues the turn continues its message.
 */
export function withAnswers(
  messages: readonly UIMessage[],
  responses: readonly ToolApprovalResponse[],
): UIMessage[] {
  const answers = new Map(responses.map((response) => [response.approvalId, response]));
  return messages.map((message, index) =>
    index < messages.length - 1
      ? message
      : {
          ...message,
          parts: message.parts.map((part): UIMessage['parts'][number] => {
            if (!isToolUIPart(part) || part.state !== 'approval-requested') return part;
            const answer = answers.get(part.approval.id);
            if (answer === undefined) return part;
            return {
              ...part,
              state: 'approval-responded',
              approval: { ...part.approval, approved: answer.approved },
            };
          }),
        },
  );
}
