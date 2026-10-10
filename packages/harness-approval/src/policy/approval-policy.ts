import type { ToolApprovalResponse } from 'ai';

import type {
  ApprovalEvaluation,
  ApprovalGrant,
  ApprovalPolicySettings,
  ApprovalVerdict,
  ToolRequest,
} from '../definitions/policy.js';
import type { ApprovalHarness, PolicyAgentSettings } from './agent-settings.js';
import type { CompiledPolicy } from './evaluate.js';

import { agentSettingsOf, warningsOf } from './agent-settings.js';
import { evaluateRequest } from './evaluate.js';
import { compileRuleSet } from './rules.js';

/** An approval request still waiting for an answer, as the stream or a session gives it. */
export type PendingApprovalRequest = ToolRequest & { approvalId: string };

/** The grants of a session, from whatever the approver is called with: `session.metadata`… */
export interface ApproverOptions<CONTEXT> {
  grants?: (context: CONTEXT) => readonly ApprovalGrant[] | undefined;
}

/** The verdict an evaluation stands for: none when someone must be asked. */
const verdictOf = ({ decision, reason }: ApprovalEvaluation): ApprovalVerdict | undefined =>
  decision === 'ask'
    ? undefined
    : { approved: decision === 'allow', ...(reason !== undefined && { reason }) };

/**
 * Reads the settings of an approval policy once: what runs, what asks, what is refused, the same
 * for every harness. See {@link ApprovalPolicy}.
 */
export function defineApprovalPolicy(settings: ApprovalPolicySettings = {}): ApprovalPolicy {
  return new ApprovalPolicy(settings);
}

/**
 * An approval policy: it evaluates each tool call the agent asks approval for — allowed, denied,
 * or left to a person — and gives a `HarnessAgent` the settings that make it ask.
 */
export class ApprovalPolicy {
  private readonly compiled: CompiledPolicy;

  constructor(readonly settings: ApprovalPolicySettings) {
    const fallback = settings.default ?? 'ask';
    this.compiled = {
      commands: compileRuleSet(settings.commands, fallback),
      edits: compileRuleSet(settings.edits, fallback),
      tools: new Map(Object.entries(settings.tools ?? {})),
      fallback,
    };
  }

  /** What the policy makes of a tool call, given the grants of the session. */
  evaluate(
    request: ToolRequest,
    options: { grants?: readonly ApprovalGrant[] } = {},
  ): ApprovalEvaluation {
    return evaluateRequest(this.compiled, request, options.grants);
  }

  /**
   * The settings of a `HarnessAgent` that make it ask what the policy decides, to spread into
   * its own: `new HarnessAgent({ harness, model, ...policy.agentSettings(harness) })`. A harness
   * that cannot ask before using its own tools, Codex today, runs with `allow-all`: see
   * {@link warnings}.
   */
  agentSettings(harness?: ApprovalHarness): PolicyAgentSettings {
    return agentSettingsOf(this.compiled, harness);
  }

  /** What the policy cannot hold `harness` to: rules it does not ask about. */
  warnings(harness: ApprovalHarness): string[] {
    return warningsOf(this.compiled, harness);
  }

  /**
   * Answers what the policy decides of the requests, and leaves the rest to a person: what a
   * route continues a turn with, `toolApprovalContinuations`.
   */
  answer<REQUEST extends PendingApprovalRequest>(
    requests: readonly REQUEST[],
    options: { grants?: readonly ApprovalGrant[] } = {},
  ): { responses: ToolApprovalResponse[]; remaining: REQUEST[] } {
    const responses: ToolApprovalResponse[] = [];
    const remaining: REQUEST[] = [];
    for (const request of requests) {
      const verdict = verdictOf(this.evaluate(request, options));
      if (verdict === undefined) remaining.push(request);
      else
        responses.push({
          type: 'tool-approval-response',
          approvalId: request.approvalId,
          ...verdict,
        });
    }
    return { responses, remaining };
  }

  /**
   * The policy as the `approve` option of `createSessionManager()`: an approval it decides is
   * answered at once, within the turn; one it leaves to a person waits for them.
   *
   * ```ts
   * createSessionManager<{ grants?: ApprovalGrant[] }>({
   *   approve: policy.approver({ grants: ({ session }) => session.metadata.grants }),
   * });
   * ```
   */
  approver<CONTEXT = unknown>(
    options: ApproverOptions<CONTEXT> = {},
  ): (request: ToolRequest, context: CONTEXT) => ApprovalVerdict | undefined {
    return (request, context) =>
      verdictOf(this.evaluate(request, { grants: options.grants?.(context) ?? [] }));
  }
}
