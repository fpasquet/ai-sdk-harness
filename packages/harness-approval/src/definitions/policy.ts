/**
 * What becomes of a tool call the agent wants to make:
 *
 * - `allow`: it runs, nobody is asked.
 * - `ask`: the turn pauses until someone approves or denies it.
 * - `deny`: it is refused, and the agent is told why.
 */
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

/** Every decision, from the most permissive to the most restrictive. */
export const APPROVAL_DECISIONS = ['allow', 'ask', 'deny'] as const;

/**
 * A pattern, alone or with the reason the agent is told when it denies a call.
 *
 * For commands, a command prefix, word by word: `git push` matches `git push origin main`, not
 * `git pushy`; `*` matches anything, `npm run test:*`. For edits, a path glob: `.env*`, `src/**`.
 */
export type ApprovalRule = string | { match: string; reason?: string };

/** The rules of one kind of tool call: the most restrictive matching rule wins. */
export interface ApprovalRuleSet {
  allow?: readonly ApprovalRule[];
  ask?: readonly ApprovalRule[];
  deny?: readonly ApprovalRule[];
  /** What becomes of a call no rule matches. Default: the policy's `default`. */
  default?: ApprovalDecision;
}

/** A tool's decision outright, alone or with the reason the agent is told when it is denied. */
export type ToolApprovalRule = ApprovalDecision | { decision: ApprovalDecision; reason?: string };

/**
 * An approval policy, the same for every harness: what runs, what asks, what is refused.
 *
 * ```ts
 * defineApprovalPolicy({
 *   commands: {
 *     allow: ['ls', 'cat', 'git status', 'git diff', 'pnpm test'],
 *     deny: [{ match: 'git push', reason: 'The application publishes the changes.' }],
 *   },
 *   edits: { allow: ['src/**'], deny: ['.env*'] },
 *   tools: { deployPreview: 'ask' },
 * });
 * ```
 */
export interface ApprovalPolicySettings {
  /**
   * The shell commands the agent runs, with Claude Code's `Bash` for instance. A command made of
   * several, `cd app && pnpm test`, is allowed only when each of them is; one that writes to a
   * file with `>` is never allowed by a rule, at most asked.
   */
  commands?: ApprovalRuleSet;
  /** The files the agent writes or edits, by path: `Write`, `Edit`, `NotebookEdit`… */
  edits?: ApprovalRuleSet;
  /**
   * Tools by name, decided outright before any other rule: a built-in tool of the harness, as it
   * names it in the stream (`webSearch`, `TodoWrite`), or one of yours. Your tools ask only when
   * they are listed here.
   */
  tools?: Readonly<Record<string, ToolApprovalRule>>;
  /** What becomes of a call no rule decides. Default: `ask`. */
  default?: ApprovalDecision;
}

/** A tool call the agent wants to make, as the stream gives it. */
export interface ToolRequest {
  toolName: string;
  input: unknown;
}

/** What the policy makes of a tool call. */
export interface ApprovalEvaluation {
  decision: ApprovalDecision;
  /** Why: what the agent is told of a denial, what a user reads of an automatic approval. */
  reason?: string;
  /** The rule, or the grant, that decided; none when the default did. */
  rule?: string;
}

/**
 * A permission a user gave for the rest of a session, "always allow": it allows what the policy
 * would have asked about, never what it denies.
 *
 * - `command`: the commands starting with `prefix`, word by word.
 * - `edit`: every file edit, or the edits of the files matching the glob `path`.
 * - `tool`: every call of the tool `toolName`.
 */
export type ApprovalGrant =
  | { kind: 'command'; prefix: string }
  | { kind: 'edit'; path?: string }
  | { kind: 'tool'; toolName: string };

/** An answer to an approval request, as `ToolApprovalResponse` carries it. */
export interface ApprovalVerdict {
  approved: boolean;
  reason?: string;
}
