import type { HarnessAgentPermissionMode } from '@ai-sdk/harness/agent';
import type { ToolApprovalStatus } from 'ai';

import type { ToolApprovalRule } from '../definitions/policy.js';
import type { CompiledPolicy } from './evaluate.js';

import { toolKindOf } from '../utils/requests.js';
import { mayRestrict } from './rules.js';

/** What a policy needs to know of a harness: `createClaudeCode()`, `createCodex()`… */
export interface ApprovalHarness {
  readonly harnessId: string;
  /** Whether it asks before using its own tools, rather than using them freely. */
  readonly supportsBuiltinToolApprovals?: boolean;
}

/** The settings of a `HarnessAgent` that make it ask what the policy decides. */
export interface PolicyAgentSettings {
  /** Which built-in tool calls the harness asks about, for the policy to decide. */
  permissionMode: HarnessAgentPermissionMode;
  /** Your tools listed in the policy's `tools`: asked about, or denied outright. */
  toolApproval: Record<string, ToolApprovalStatus>;
}

const decisionOf = (rule: ToolApprovalRule) => (typeof rule === 'string' ? rule : rule.decision);

/** Whether the policy may ask about, or refuse, a command or an edit. */
function restricts(policy: CompiledPolicy, kind: 'command' | 'edit'): boolean {
  if (mayRestrict(kind === 'command' ? policy.commands : policy.edits)) return true;
  return [...policy.tools].some(
    ([toolName, rule]) => toolKindOf(toolName) === kind && decisionOf(rule) !== 'allow',
  );
}

const supportsApprovals = (harness: ApprovalHarness | undefined): boolean =>
  harness === undefined || harness.supportsBuiltinToolApprovals === true;

/**
 * The least permissive mode the policy needs: the harness asks about every edit and command when
 * the policy may restrict edits, about commands only when it restricts commands alone, about
 * nothing when it restricts neither — or when the harness cannot ask.
 */
export function agentSettingsOf(
  policy: CompiledPolicy,
  harness: ApprovalHarness | undefined,
): PolicyAgentSettings {
  const permissionMode: HarnessAgentPermissionMode = !supportsApprovals(harness)
    ? 'allow-all'
    : restricts(policy, 'edit')
      ? 'allow-reads'
      : restricts(policy, 'command')
        ? 'allow-edits'
        : 'allow-all';
  const toolApproval: Record<string, ToolApprovalStatus> = {};
  for (const [toolName, rule] of policy.tools) {
    const decision = decisionOf(rule);
    const reason = typeof rule === 'string' ? undefined : rule.reason;
    if (decision === 'ask') toolApproval[toolName] = 'user-approval';
    if (decision === 'deny') {
      toolApproval[toolName] = { type: 'denied', ...(reason !== undefined && { reason }) };
    }
  }
  return { permissionMode, toolApproval };
}

/** The settings of a Claude Code agent whose policy the sandbox holds it to. */
export interface ClaudeCodeSandboxSettings {
  /** For `createClaudeCode()`: names the policy, for the hook installed in the sandbox. */
  harness: { env: Record<string, string> };
  /**
   * For the `HarnessAgent`: `allow-all`, the hook deciding every command and edit before it
   * runs; your tools listed in the policy's `tools` still asked about, or denied.
   */
  agent: PolicyAgentSettings;
}

/** Whether the policy may leave a command or an edit to a person. */
export function mayAsk(policy: CompiledPolicy): boolean {
  return [policy.commands, policy.edits].some(
    (set) => set.ask.length > 0 || set.fallback === 'ask',
  );
}

/** The settings of a Claude Code agent held to the policy in its sandbox. */
export function claudeCodeSandboxOf(
  policy: CompiledPolicy,
  name: string,
  env: string,
): ClaudeCodeSandboxSettings {
  const { toolApproval } = agentSettingsOf(policy, undefined);
  return {
    harness: { env: { [env]: name } },
    agent: { permissionMode: 'allow-all', toolApproval },
  };
}

/** What the policy cannot hold the harness to. */
export function warningsOf(policy: CompiledPolicy, harness: ApprovalHarness | undefined): string[] {
  if (supportsApprovals(harness) || harness === undefined) return [];
  const kinds = (['command', 'edit'] as const).filter((kind) => restricts(policy, kind));
  if (kinds.length === 0) return [];
  const what = kinds.map((kind) => (kind === 'command' ? 'commands' : 'edits')).join(' and ');
  return [
    `${harness.harnessId} does not ask before using its own tools: the rules on ${what} do not apply, it runs them freely. Rules on your own tools still apply.`,
  ];
}
