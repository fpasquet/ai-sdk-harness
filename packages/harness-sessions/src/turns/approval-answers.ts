import type { ToolApprovalResponse, UIMessageChunk } from 'ai';

import type { ApprovalVerdict, PendingApproval } from '../definitions/session.js';

/** An approval request as a repeat of another is recognised: the same tool, the same input. */
export const signatureOf = ({ toolName, input }: PendingApproval): string =>
  `${toolName}\u0000${JSON.stringify(input)}`;

/** A verdict with only what an approval response carries. */
export const verdictOf = ({ approved, reason }: ApprovalVerdict): ApprovalVerdict => ({
  approved,
  ...(reason !== undefined && { reason }),
});

/** The approval responses of the approvals decided already. */
export function decidedResponses(approvals: readonly PendingApproval[]): ToolApprovalResponse[] {
  return approvals.flatMap(({ approvalId, decision }) =>
    decision === undefined
      ? []
      : [{ type: 'tool-approval-response' as const, approvalId, ...verdictOf(decision) }],
  );
}

/** The chunks that show a client the approvals decided already, as answered. */
export function decidedChunks(approvals: readonly PendingApproval[]): UIMessageChunk[] {
  return decidedResponses(approvals).map(({ approvalId, approved, reason }) => ({
    type: 'tool-approval-response',
    approvalId,
    approved,
    ...(reason !== undefined && { reason }),
  }));
}
