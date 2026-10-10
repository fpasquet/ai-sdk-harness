import type {
  ApprovalDecision,
  ApprovalEvaluation,
  ApprovalRule,
  ApprovalRuleSet,
} from '../definitions/policy.js';

import { APPROVAL_DECISIONS } from '../definitions/policy.js';

interface CompiledRule {
  pattern: string;
  reason?: string;
}

/** A rule set read once: its rules by decision, and what decides when none matches. */
export interface CompiledRuleSet {
  allow: CompiledRule[];
  ask: CompiledRule[];
  deny: CompiledRule[];
  fallback: ApprovalDecision;
}

const compile = (rules: readonly ApprovalRule[] = []): CompiledRule[] =>
  rules.map((rule) =>
    typeof rule === 'string'
      ? { pattern: rule }
      : { pattern: rule.match, ...(rule.reason !== undefined && { reason: rule.reason }) },
  );

export function compileRuleSet(
  set: ApprovalRuleSet | undefined,
  fallback: ApprovalDecision,
): CompiledRuleSet {
  return {
    allow: compile(set?.allow),
    ask: compile(set?.ask),
    deny: compile(set?.deny),
    fallback: set?.default ?? fallback,
  };
}

/** Whether a rule set may ask about or refuse a call: it has such rules, or such a fallback. */
export const mayRestrict = (set: CompiledRuleSet): boolean =>
  set.ask.length > 0 || set.deny.length > 0 || set.fallback !== 'allow';

/** What a rule set decides on: what its patterns match, and how a reason names it. */
export interface Subject {
  /** What is matched against the patterns: a command, a path. */
  value: string;
  /** How a reason names it: "the command `rm -rf dist`". */
  label: string;
}

export function deniedReason(label: string, pattern?: string): string {
  return pattern === undefined
    ? `The approval policy does not allow ${label}.`
    : `The approval policy does not allow ${label} (\`${pattern}\`).`;
}

/** What one rule set makes of one subject: the deny rules first, then ask, then allow. */
export function decide(
  set: CompiledRuleSet,
  subject: Subject,
  matches: (pattern: string, value: string) => boolean,
): ApprovalEvaluation {
  for (const decision of [...APPROVAL_DECISIONS].reverse()) {
    const rule = set[decision].find(({ pattern }) => matches(pattern, subject.value));
    if (rule === undefined) continue;
    if (decision === 'deny') {
      return {
        decision,
        reason: rule.reason ?? deniedReason(subject.label, rule.pattern),
        rule: rule.pattern,
      };
    }
    if (decision === 'allow') {
      return {
        decision,
        reason: rule.reason ?? `Allowed by the approval policy (\`${rule.pattern}\`).`,
        rule: rule.pattern,
      };
    }
    return {
      decision,
      ...(rule.reason !== undefined && { reason: rule.reason }),
      rule: rule.pattern,
    };
  }
  return set.fallback === 'deny'
    ? { decision: 'deny', reason: deniedReason(subject.label) }
    : { decision: set.fallback };
}

const RANK: Record<ApprovalDecision, number> = { allow: 0, ask: 1, deny: 2 };

/** The most restrictive of several evaluations: a command is only as allowed as its worst part. */
export function strictest(
  evaluations: readonly ApprovalEvaluation[],
  fallback: ApprovalEvaluation,
): ApprovalEvaluation {
  return (
    evaluations.reduce<ApprovalEvaluation | undefined>(
      (worst, evaluation) =>
        worst === undefined || RANK[evaluation.decision] > RANK[worst.decision]
          ? evaluation
          : worst,
      undefined,
    ) ?? fallback
  );
}
