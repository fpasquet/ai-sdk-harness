'use client';

import type { DynamicToolUIPart, ToolUIPart } from 'ai';
import type { ApprovalGrant } from 'ai-sdk-harness-approval';

import { getToolName } from 'ai';
import { describeToolCall, suggestGrant } from 'ai-sdk-harness-approval';
import { CheckIcon, ShieldCheckIcon, ShieldXIcon, XIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** What a person answered: `addToolApprovalResponse()`, plus the grants of "Always allow". */
export interface ToolApprovalResponse {
  approvalId: string;
  approved: boolean;
  reason?: string;
  /** What to allow for the rest of the session: keep them where your approval policy reads them. */
  grants?: ApprovalGrant[];
}

/**
 * The approval of a tool call of a harness agent: what it does, in a few words, with Approve,
 * Deny, and "Always allow" for the rest of the session while it waits; the answer once given,
 * with its reason — "Allowed by the approval policy (`ls`)" when the policy gave it.
 *
 * From the ai-sdk-harness registry: https://ai-sdk-harness.pages.dev/docs/ui-components
 */
export function ToolApproval({
  className,
  onRespond,
  part,
}: {
  className?: string;
  /** Called with the person's answer; without it, the request only shows. */
  onRespond?: (response: ToolApprovalResponse) => void;
  part: DynamicToolUIPart | ToolUIPart;
}) {
  if (part.approval === undefined) return null;
  const request = { toolName: getToolName(part), input: part.input };
  const { detail, title } = describeToolCall(request);
  const { approved, id, reason } = part.approval;
  const waiting = part.state === 'approval-requested';

  return (
    <div className={cn('space-y-2 border-t p-3 text-sm', className)}>
      <div className="flex items-center gap-2">
        <span className="font-medium">{waiting ? `${title}?` : title}</span>
        {!waiting && approved !== undefined && <Verdict approved={approved} reason={reason} />}
      </div>
      {detail && (
        <pre className="max-h-40 overflow-auto rounded-md bg-muted px-3 py-2 font-mono text-xs whitespace-pre-wrap">
          {detail}
        </pre>
      )}
      {waiting && onRespond && (
        <Answers
          grant={suggestGrant(request)}
          onRespond={(answer) => onRespond({ approvalId: id, ...answer })}
        />
      )}
    </div>
  );
}

function Verdict({ approved, reason }: { approved: boolean; reason?: string }) {
  const Icon = approved ? ShieldCheckIcon : ShieldXIcon;
  return (
    <span
      className={cn(
        'flex min-w-0 items-center gap-1 text-xs',
        approved ? 'text-muted-foreground' : 'text-destructive',
      )}
    >
      <Icon className="size-3.5 shrink-0" />
      <span className="truncate">
        {approved ? 'Approved' : 'Denied'}
        {reason ? `: ${reason}` : ''}
      </span>
    </span>
  );
}

function Answers({
  grant,
  onRespond,
}: {
  grant: ReturnType<typeof suggestGrant>;
  onRespond: (answer: Omit<ToolApprovalResponse, 'approvalId'>) => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <Button onClick={() => onRespond({ approved: false })} size="sm" variant="outline">
        <XIcon /> Deny
      </Button>
      <Button
        onClick={() => onRespond({ approved: true, grants: grant.grants })}
        size="sm"
        variant="outline"
      >
        <ShieldCheckIcon /> {grant.label}
      </Button>
      <Button onClick={() => onRespond({ approved: true })} size="sm">
        <CheckIcon /> Approve
      </Button>
    </div>
  );
}
