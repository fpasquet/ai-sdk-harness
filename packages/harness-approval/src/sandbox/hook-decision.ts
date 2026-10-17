import type { ApprovalPolicySettings, ToolRequest } from '../definitions/policy.js';

import { defineApprovalPolicy } from '../policy/approval-policy.js';
import { toolKindOf } from '../utils/requests.js';

/** What Claude Code gives a `PreToolUse` hook of the call it is about to make. */
export interface HookInput {
  tool_name?: unknown;
  tool_input?: unknown;
}

/** What the hook answers Claude Code; nothing leaves the call to Claude Code's own settings. */
export interface HookDecision {
  decision: 'allow' | 'deny';
  reason: string;
}

/**
 * The name the policy's `tools` give a built-in tool: as Claude Code names it (`WebSearch`), or
 * as the stream does (`webSearch`).
 */
function ruleNameOf(settings: ApprovalPolicySettings, toolName: string): string | undefined {
  const streamed = `${toolName.charAt(0).toLowerCase()}${toolName.slice(1)}`;
  return [toolName, streamed].find((name) => settings.tools?.[name] !== undefined);
}

/** The call as the policy reads it, when the hook decides it. */
function requestOf(settings: ApprovalPolicySettings, input: HookInput): ToolRequest | undefined {
  const toolName = typeof input.tool_name === 'string' ? input.tool_name : '';
  if (toolName === '' || toolName.startsWith('mcp__')) return undefined;
  const named = ruleNameOf(settings, toolName);
  const kind = toolKindOf(toolName);
  if (named === undefined && kind !== 'command' && kind !== 'edit') return undefined;
  return { toolName: named ?? toolName, input: input.tool_input };
}

/**
 * What the policy makes of a call Claude Code is about to make in the sandbox. The hook decides
 * commands, edits and the built-in tools the policy names; reads, the agent's bookkeeping and
 * your tools (`mcp__…`, approved on your side) are left to Claude Code. What the policy would ask
 * a person about is denied: nobody can be asked from the sandbox.
 */
export function hookDecision(
  settings: ApprovalPolicySettings,
  input: HookInput,
): HookDecision | undefined {
  const request = requestOf(settings, input);
  if (request === undefined) return undefined;
  const { decision, reason } = defineApprovalPolicy(settings).evaluate(request);
  if (decision === 'ask') {
    const why = reason === undefined ? '' : `${reason} `;
    return {
      decision: 'deny',
      reason: `${why}The approval policy would ask a person, and nobody can be asked from the sandbox.`,
    };
  }
  return { decision, reason: reason ?? 'Allowed by the approval policy.' };
}
