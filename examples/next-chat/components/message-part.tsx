import type { DynamicToolUIPart, ToolUIPart, UIMessage } from 'ai';

import { getToolName, isToolUIPart } from 'ai';
import { CheckIcon, XIcon } from 'lucide-react';

import { MessageResponse } from '@/components/ai-elements/message';
import { Reasoning, ReasoningContent, ReasoningTrigger } from '@/components/ai-elements/reasoning';
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from '@/components/ai-elements/tool';
import { Button } from '@/components/ui/button';

type Part = UIMessage['parts'][number];

/** Answers a tool call the agent asked approval for. */
type OnApproval = (approvalId: string, approved: boolean) => void;

/**
 * One part of a message: the agent's answer, rendered as Markdown while it streams in, its
 * reasoning, or a tool it ran in the sandbox, such as Claude Code's own `Bash`, `Read`, `Write`…
 */
export function MessagePart({
  isStreaming,
  onApproval,
  part,
}: {
  isStreaming: boolean;
  onApproval: OnApproval;
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
  if (isToolUIPart(part)) return <ToolCall onApproval={onApproval} part={part} />;
  return null;
}

/**
 * A tool call, open while it waits for approval: the session is `awaiting-input` until it is
 * approved or denied, and resumes the turn then, even after it was suspended.
 */
function ToolCall({
  onApproval,
  part,
}: {
  onApproval: OnApproval;
  part: DynamicToolUIPart | ToolUIPart;
}) {
  const waiting = part.state === 'approval-requested';
  return (
    <Tool>
      <ToolHeader state={part.state} title={getToolName(part)} type={part.type} />
      {/* Outside the collapsible content: shown whether the call is open or not. */}
      {waiting && (
        <div className="flex items-center justify-end gap-2 border-t p-3">
          <code className="mr-auto truncate text-xs text-muted-foreground">
            {JSON.stringify(part.input)}
          </code>
          <Button onClick={() => onApproval(part.approval.id, false)} size="sm" variant="outline">
            <XIcon /> Deny
          </Button>
          <Button onClick={() => onApproval(part.approval.id, true)} size="sm">
            <CheckIcon /> Approve
          </Button>
        </div>
      )}
      <ToolContent>
        <ToolInput input={part.input} />
        <ToolOutput errorText={part.errorText} output={part.output} />
      </ToolContent>
    </Tool>
  );
}
