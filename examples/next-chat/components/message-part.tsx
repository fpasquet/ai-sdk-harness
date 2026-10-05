import type { DynamicToolUIPart, ToolUIPart, UIMessage } from 'ai';

import { getToolName, isToolUIPart } from 'ai';

import { MessageResponse } from '@/components/ai-elements/message';
import { Reasoning, ReasoningContent, ReasoningTrigger } from '@/components/ai-elements/reasoning';
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from '@/components/ai-elements/tool';

type Part = UIMessage['parts'][number];

/**
 * One part of a message: the agent's answer, rendered as Markdown while it streams in, its
 * reasoning, or a tool it ran in the sandbox, such as Claude Code's own `Bash`, `Read`, `Write`…
 */
export function MessagePart({ part, isStreaming }: { isStreaming: boolean; part: Part }) {
  if (part.type === 'text') return <MessageResponse>{part.text}</MessageResponse>;
  if (part.type === 'reasoning') {
    return (
      <Reasoning className="w-full" isStreaming={isStreaming}>
        <ReasoningTrigger />
        <ReasoningContent>{part.text}</ReasoningContent>
      </Reasoning>
    );
  }
  if (isToolUIPart(part)) return <ToolCall part={part} />;
  return null;
}

function ToolCall({ part }: { part: DynamicToolUIPart | ToolUIPart }) {
  return (
    <Tool>
      <ToolHeader state={part.state} title={getToolName(part)} type={part.type} />
      <ToolContent>
        <ToolInput input={part.input} />
        <ToolOutput errorText={part.errorText} output={part.output} />
      </ToolContent>
    </Tool>
  );
}
