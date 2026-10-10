import type { DynamicToolUIPart, ToolUIPart, UIMessage } from 'ai';
import type { AgentAnswers, AgentQuestions } from 'ai-sdk-harness-approval';

import { getToolName, isToolUIPart } from 'ai';
import { QUESTIONS_TOOL_NAME } from 'ai-sdk-harness-approval';

import type { ToolApprovalResponse } from '@/components/harness/tool-approval';

import { MessageResponse } from '@/components/ai-elements/message';
import { Reasoning, ReasoningContent, ReasoningTrigger } from '@/components/ai-elements/reasoning';
import { Shimmer } from '@/components/ai-elements/shimmer';
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from '@/components/ai-elements/tool';
import { AnsweredQuestions, QuestionsForm } from '@/components/harness/questions-form';
import { ToolApproval } from '@/components/harness/tool-approval';

type Part = UIMessage['parts'][number];

/** What a person answers the agent: an approval, or its questions. */
export interface PartAnswers {
  onApproval: (response: ToolApprovalResponse) => void;
  onAnswers: (toolCallId: string, answers: AgentAnswers) => void;
}

/**
 * One part of a message: the agent's answer, rendered as Markdown while it streams in, its
 * reasoning, its questions, or a tool it ran in the sandbox, such as Claude Code's own `Bash`,
 * `Read`, `Write`…
 */
export function MessagePart({
  answers,
  isStreaming,
  part,
}: {
  answers: PartAnswers;
  isStreaming: boolean;
  part: Part;
}) {
  if (part.type === 'text') return <MessageResponse>{part.text}</MessageResponse>;
  if (part.type === 'reasoning') {
    return (
      <Reasoning className="w-full" isStreaming={isStreaming}>
        <ReasoningTrigger />
        <ReasoningContent>{part.text}</ReasoningContent>
      </Reasoning>
    );
  }
  if (!isToolUIPart(part)) return null;
  if (getToolName(part) === QUESTIONS_TOOL_NAME) {
    return <Questions onAnswers={answers.onAnswers} part={part} />;
  }
  return <ToolCall onApproval={answers.onApproval} part={part} />;
}

/**
 * The agent's questions: a form while the turn waits for the answers — the session `awaiting-input`
 * meanwhile —, the answers once given.
 */
function Questions({
  onAnswers,
  part,
}: {
  onAnswers: PartAnswers['onAnswers'];
  part: DynamicToolUIPart | ToolUIPart;
}) {
  const questions = part.input as AgentQuestions | undefined;
  if (part.state === 'input-streaming' || questions?.questions === undefined) {
    return <Shimmer className="text-sm">The agent is writing its questions…</Shimmer>;
  }
  if (part.state === 'output-available') {
    return <AnsweredQuestions answers={part.output as AgentAnswers} questions={questions} />;
  }
  return (
    <QuestionsForm
      disabled={part.state !== 'input-available'}
      onSubmit={(answers) => onAnswers(part.toolCallId, answers)}
      questions={questions}
    />
  );
}

/**
 * A tool call, with its approval when it asked for one: the session is `awaiting-input` until a
 * person approves or denies it, and resumes the turn then, even after it was suspended. One the
 * approval policy answered shows its verdict and why.
 */
function ToolCall({
  onApproval,
  part,
}: {
  onApproval: PartAnswers['onApproval'];
  part: DynamicToolUIPart | ToolUIPart;
}) {
  return (
    <Tool>
      <ToolHeader state={part.state} title={getToolName(part)} type={part.type} />
      {/* Outside the collapsible content: shown whether the call is open or not. */}
      <ToolApproval onRespond={onApproval} part={part} />
      <ToolContent>
        <ToolInput input={part.input} />
        <ToolOutput errorText={part.errorText} output={part.output} />
      </ToolContent>
    </Tool>
  );
}
