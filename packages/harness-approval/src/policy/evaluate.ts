import type {
  ApprovalDecision,
  ApprovalEvaluation,
  ApprovalGrant,
  ToolApprovalRule,
  ToolRequest,
} from '../definitions/policy.js';
import type { CompiledRuleSet } from './rules.js';

import { matchesCommand, matchesPath } from '../utils/patterns.js';
import { commandOf, normalizePath, pathsOf, toolKindOf } from '../utils/requests.js';
import { type CommandSegment, commandSegments } from '../utils/shell.js';
import { describeGrant, grantFor } from './grants.js';
import { decide, deniedReason, strictest } from './rules.js';

/** A policy read once, ready to evaluate tool calls. */
export interface CompiledPolicy {
  commands: CompiledRuleSet;
  edits: CompiledRuleSet;
  tools: ReadonlyMap<string, ToolApprovalRule>;
  fallback: ApprovalDecision;
}

const allowedBy = (grant: ApprovalGrant): ApprovalEvaluation => ({
  decision: 'allow',
  reason: `Allowed for this session: ${describeGrant(grant)}.`,
  rule: describeGrant(grant),
});

/** What the policy's default makes of a call no rule decides. */
function byDefault(fallback: ApprovalDecision, label: string): ApprovalEvaluation {
  return fallback === 'deny'
    ? { decision: 'deny', reason: deniedReason(label) }
    : { decision: fallback };
}

function outright(rule: ToolApprovalRule, toolName: string): ApprovalEvaluation {
  const { decision, reason } =
    typeof rule === 'string' ? { decision: rule, reason: undefined } : rule;
  if (decision === 'deny') {
    return { decision, reason: reason ?? deniedReason(`the tool ${toolName}`), rule: toolName };
  }
  if (decision === 'allow') {
    return {
      decision,
      reason: reason ?? `Allowed by the approval policy (${toolName}).`,
      rule: toolName,
    };
  }
  return { decision, ...(reason !== undefined && { reason }), rule: toolName };
}

/** The files a command writes to, as a reason names them. */
const filesOf = (files: readonly string[]): string =>
  files.length === 0 ? 'a file' : files.map((file) => `\`${file}\``).join(', ');

/**
 * A redirection edits the files it writes to: the edit rules, and the grants of edits, decide them.
 * A file the shell names only as it runs, `> "$OUT"` or `> ~/out`, is asked about.
 */
function evaluateWrites(
  policy: CompiledPolicy,
  { command, files }: Pick<CommandSegment, 'command' | 'files'>,
  grants: readonly ApprovalGrant[],
): ApprovalEvaluation {
  const asked: ApprovalEvaluation = {
    decision: 'ask',
    reason: `\`${command}\` writes to ${filesOf(files)}.`,
  };
  if (files.length === 0 || files.some((file) => /[$`~*?[]/.test(file))) return asked;
  const evaluations = files.map((file): ApprovalEvaluation => {
    const path = normalizePath(file);
    const evaluation = decide(
      policy.edits,
      { value: path, label: `\`${command}\` writing to \`${file}\`` },
      matchesPath,
    );
    const grant =
      evaluation.decision === 'ask' ? grantFor(grants, { kind: 'edit', value: path }) : undefined;
    return grant === undefined ? evaluation : allowedBy(grant);
  });
  const worst = strictest(evaluations, byDefault(policy.edits.fallback, 'this edit'));
  return worst.decision === 'ask' ? asked : worst;
}

/** A command made of several is only as allowed as the least allowed of them. */
function evaluateCommand(
  policy: CompiledPolicy,
  { toolName, input }: ToolRequest,
  grants: readonly ApprovalGrant[],
): ApprovalEvaluation {
  const segments = commandSegments(commandOf(toolName, input) ?? '');
  const evaluations = segments.map(({ command, writes, files }): ApprovalEvaluation => {
    // A redirection alone, `> .env`, runs no command: only what it writes is decided.
    if (command === '') return evaluateWrites(policy, { command: '>', files }, grants);
    const evaluation = decide(
      policy.commands,
      { value: command, label: `the command \`${command}\`` },
      matchesCommand,
    );
    if (evaluation.decision === 'deny') return evaluation;
    const grant =
      evaluation.decision === 'ask'
        ? grantFor(grants, { kind: 'command', value: command })
        : undefined;
    const allowed = grant === undefined ? evaluation : allowedBy(grant);
    if (!writes) return allowed;
    // Allowed as a command, it is then only as allowed as the edits it makes.
    const written = evaluateWrites(policy, { command, files }, grants);
    return written.decision === 'allow' ? allowed : written;
  });
  const worst = strictest(evaluations, byDefault(policy.commands.fallback, 'this command'));
  if (worst.decision !== 'allow' || evaluations.length < 2) return worst;
  // Allowed throughout: the reason names every rule that allowed it.
  const rules = [...new Set(evaluations.flatMap(({ rule }) => (rule === undefined ? [] : [rule])))];
  return {
    decision: 'allow',
    reason: `Allowed by the approval policy (${rules.map((rule) => `\`${rule}\``).join(', ')}).`,
    rule: rules.join(', '),
  };
}

function evaluateEdit(
  policy: CompiledPolicy,
  { input }: ToolRequest,
  grants: readonly ApprovalGrant[],
): ApprovalEvaluation {
  const evaluations = pathsOf(input).map((path): ApprovalEvaluation => {
    const evaluation = decide(
      policy.edits,
      { value: path, label: `editing \`${path}\`` },
      matchesPath,
    );
    const grant =
      evaluation.decision === 'ask' ? grantFor(grants, { kind: 'edit', value: path }) : undefined;
    return grant === undefined ? evaluation : allowedBy(grant);
  });
  return strictest(evaluations, byDefault(policy.edits.fallback, 'this edit'));
}

function evaluateByKind(
  policy: CompiledPolicy,
  request: ToolRequest,
  grants: readonly ApprovalGrant[],
): ApprovalEvaluation {
  const rule = policy.tools.get(request.toolName);
  if (rule !== undefined) return outright(rule, request.toolName);
  switch (toolKindOf(request.toolName)) {
    case 'command':
      return evaluateCommand(policy, request, grants);
    case 'edit':
      return evaluateEdit(policy, request, grants);
    case 'bookkeeping':
      return { decision: 'allow' };
    case 'other':
      return byDefault(policy.fallback, `the tool ${request.toolName}`);
  }
}

/**
 * What the policy makes of a tool call: a tool's own rule first, then the rules of its kind, the
 * grants of the session for what they would ask about, and the default for the rest.
 */
export function evaluateRequest(
  policy: CompiledPolicy,
  request: ToolRequest,
  grants: readonly ApprovalGrant[] = [],
): ApprovalEvaluation {
  const evaluation = evaluateByKind(policy, request, grants);
  if (evaluation.decision !== 'ask') return evaluation;
  const grant = grantFor(grants, { kind: 'tool', value: request.toolName });
  return grant === undefined ? evaluation : allowedBy(grant);
}
