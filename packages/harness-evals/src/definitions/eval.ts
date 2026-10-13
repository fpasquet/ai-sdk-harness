import type { HarnessV1NetworkSandboxSession } from '@ai-sdk/harness';
import type { HarnessAgentSession } from '@ai-sdk/harness/agent';
import type {
  LanguageModel,
  LanguageModelUsage,
  StreamTextResult,
  ToolApprovalResponse,
  ToolSet,
  UIMessage,
} from 'ai';
import type { Plugin } from 'ai-sdk-harness-plugins';

/** A turn's result, whatever the agent's runtime context and output. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- any context, any output
type AnyStreamTextResult = StreamTextResult<ToolSet, any, any>;

/** What an eval reads of a turn: a `StreamTextResult` is one. */
export type EvalStreamResult = Pick<AnyStreamTextResult, 'totalUsage' | 'toUIMessageStream'>;

/**
 * The agent under evaluation: a `HarnessAgent` is one, whatever its harness, model, tools and
 * plugins.
 */
export interface EvalAgent {
  createSession(options: {
    sessionId?: string;
    sandboxSession: HarnessV1NetworkSandboxSession;
    abortSignal?: AbortSignal;
  }): Promise<HarnessAgentSession>;
  stream(options: {
    session: HarnessAgentSession;
    prompt: string;
    abortSignal?: AbortSignal;
  }): PromiseLike<EvalStreamResult>;
  continueStream(options: {
    session: HarnessAgentSession;
    toolApprovalContinuations?: readonly ToolApprovalResponse[];
    abortSignal?: AbortSignal;
  }): PromiseLike<EvalStreamResult>;
}

/** The sandbox an eval session holds while its trial runs. */
export interface EvalSandboxLease {
  readonly sandboxSession: HarnessV1NetworkSandboxSession;
  /** The trial is over: free what it held. */
  close(): Promise<void>;
}

/**
 * Where the trials get a sandbox: the `SessionSandboxes` of `ai-sdk-harness-sessions` —
 * `sharedSandbox()`, a view of one sandbox with a port of its own for each trial, or
 * `sandboxPerSession()`, a sandbox each — are ones. Their `capacity` is how many trials run at once.
 */
export interface EvalSandboxes {
  readonly capacity?: number;
  acquire(
    sessionId: string,
    options: { resume: boolean; abortSignal?: AbortSignal },
  ): Promise<EvalSandboxLease>;
}

/** A criterion the judge grades the answer on, with the score it must reach. */
export interface JudgeCriterion {
  /** What a good answer does, in plain words: `The answer cites the documentation`. */
  criteria: string;
  /** The score, from 0 to 1, the answer must reach. Default: `0.7`. */
  threshold?: number;
}

/**
 * Text to look for: a string as it is, a RegExp, or — as JSON writes it — a RegExp's source and
 * flags, `{ "regex": "^feat", "flags": "im" }`.
 */
export type TextPattern = RegExp | string | { regex: string; flags?: string };

/**
 * What the agent must have done by the end of the case. Every expectation is plain data, so cases
 * can be written as JSON; each one becomes a check of the report.
 */
export interface EvalExpectations {
  /** Text the last answer contains, each of them: a string matches as is, a RegExp as a pattern. */
  includes?: readonly TextPattern[] | TextPattern;
  /** Text the last answer does not contain, any of them. */
  excludes?: readonly TextPattern[] | TextPattern;
  /**
   * Tools the agent called, each at least once and without an error. A runtime's own tools match
   * whatever the runtime names them: `bash` is Claude Code's `Bash` and Codex's `shell`.
   */
  calledTools?: readonly string[];
  /** Tools the agent never called. */
  notCalledTools?: readonly string[];
  /** Skills the agent loaded, each of them. */
  loadedSkills?: readonly string[];
  /** The most tool calls the case may take, over all its turns. */
  maxToolCalls?: number;
  /** No tool call ended in an error. */
  noToolErrors?: boolean;
  /**
   * What the judge grades the last answer on (the `judge` model of `evaluate()`): a criterion, a
   * criterion with its threshold, or several.
   */
  judge?: JudgeCriterion | readonly (JudgeCriterion | string)[] | string;
}

/** The outcome of a check of your own. */
export interface CheckOutcome {
  passed: boolean;
  /** From 0 to 1. Default: 1 when it passed, 0 otherwise. */
  score?: number;
  /** Why it failed, shown in the report. */
  message?: string;
}

/** One case: what to ask the agent, and what it must have done. */
export interface EvalCase {
  /** Names the case in the report: unique among the cases. */
  name: string;
  /**
   * What to send: one message, or the messages of several turns of the same session. A
   * `/command` is expanded with the `plugins` of `evaluate()`, as your application would.
   */
  prompt: readonly string[] | string;
  /** What the agent must have done by the end of the case. */
  expect?: EvalExpectations;
  /** A check of your own, run after the expectations, on everything the case observed. */
  check?: (run: EvalRun) => boolean | CheckOutcome | Promise<boolean | CheckOutcome>;
  /** Overrides the `trials` of `evaluate()`. */
  trials?: number;
  /** Overrides the `approvals` of `evaluate()`. */
  approvals?: EvalApprovals;
  /** Overrides the `timeoutMs` of `evaluate()`. */
  timeoutMs?: number;
  /** Free-form labels, kept in the report: to filter cases, or group them. */
  tags?: readonly string[];
  /**
   * The runtimes the case is made for, by harness id (`claude-code`, `codex`): with the `harness`
   * of `evaluate()`, the case is skipped on the others — a hook on Codex, for instance.
   */
  harnesses?: readonly string[];
}

/** What a turn that pauses on a tool approval gets: every request approved, or denied. */
export type EvalApprovals = 'approve' | 'deny';

/** How a tool call ended. */
export type EvalToolCallStatus = 'completed' | 'denied' | 'failed' | 'pending';

/** One tool call the agent made. */
export interface EvalToolCall {
  /** The tool's name, as the stream gives it: `Bash`, `kernel`, `context7_query-docs`… */
  name: string;
  input: unknown;
  /** The tool's output, once it completed. */
  output?: unknown;
  /** The error, when it failed. */
  error?: string;
  status: EvalToolCallStatus;
  /** The index of the turn it was made in, from 0. */
  turn: number;
}

/** One turn of a case. */
export interface EvalTurn {
  /** The prompt sent, a `/command` expanded. */
  prompt: string;
  /** The answer's text. */
  text: string;
  toolCalls: EvalToolCall[];
}

/** The result of one check. */
export interface EvalCheck {
  /** What was checked: `calledTools(kernel)`, `judge(The answer cites…)`… */
  name: string;
  passed: boolean;
  /** From 0 to 1: 0 or 1 for a deterministic check, the judge's score for a judge. */
  score: number;
  /** Why it failed, or what the judge said. */
  message?: string;
}

/** One trial of a case: what the agent did, and the checks of it. */
export interface EvalRun {
  /** The last answer's text. */
  text: string;
  turns: EvalTurn[];
  /** Every tool call, over all the turns. */
  toolCalls: EvalToolCall[];
  /** The skills the agent loaded. */
  skills: string[];
  /** The conversation, as the UI messages of the AI SDK. */
  messages: UIMessage[];
  usage: Pick<LanguageModelUsage, 'inputTokens' | 'outputTokens' | 'totalTokens'>;
  durationMs: number;
  /** What went wrong, when the trial could not run to its end: no check is then run. */
  error?: string;
  checks: EvalCheck[];
  /** No error, and every check passed. */
  passed: boolean;
  /** The mean score of the checks; 0 on an error, 1 with no check. */
  score: number;
}

/** The report of one case. */
export interface EvalCaseReport {
  name: string;
  tags: readonly string[];
  /** Why the case did not run: it is made for other runtimes. It then counts as passed. */
  skipped?: string;
  /** The share of trials that passed reached `minPassRate`. */
  passed: boolean;
  /** The share of trials that passed, from 0 to 1. */
  passRate: number;
  /** The mean score of the trials. */
  score: number;
  trials: EvalRun[];
}

/** The report of `evaluate()`: plain JSON but for the RegExps of the cases, to keep or send on. */
export interface EvalReport {
  /** Every case passed. */
  passed: boolean;
  /** The mean score of the cases that ran; 1 when none did. */
  score: number;
  cases: EvalCaseReport[];
  durationMs: number;
}

/** The settings of `evaluate()`. */
export interface EvaluateSettings {
  /** The agent under evaluation, a `HarnessAgent`. */
  agent: EvalAgent;
  /**
   * Where its sessions run, each trial a new session destroyed at its end: one sandbox, the trials
   * one after the other; or sandboxes (`sharedSandbox()` or `sandboxPerSession()` of
   * `ai-sdk-harness-sessions`), several trials at once.
   */
  sandbox: EvalSandboxes | HarnessV1NetworkSandboxSession;
  /**
   * How many trials run at once: at most the `capacity` of the sandboxes, which it defaults to; 1
   * with one sandbox, whose bridge port one session holds at a time.
   */
  concurrency?: number;
  cases: readonly EvalCase[];
  /**
   * The agent's plugins, when its prompts use their `/commands` (or `/skills`): they are expanded
   * as `expandCommand()` of `ai-sdk-harness-plugins` does it in your application.
   */
  plugins?: readonly Plugin[];
  /** The model that grades the `judge` expectations: never the agent's. */
  judge?: LanguageModel;
  /** How many times each case runs: the agents are not deterministic. Default: 1. */
  trials?: number;
  /**
   * The agent's runtime, by harness id (`claude-code`, `codex`): the cases made for other
   * runtimes (`harnesses`) are skipped. Every case runs when absent.
   */
  harness?: string;
  /** The share of a case's trials that must pass, from 0 to 1. Default: 1, every trial. */
  minPassRate?: number;
  /** What a turn that pauses on a tool approval gets. Default: `'approve'`. */
  approvals?: EvalApprovals;
  /** How long a trial may take, every turn of it. Default: 5 minutes. */
  timeoutMs?: number;
  /** Called once a case is over, all its trials run: to show progress. */
  onCaseEnd?: (report: EvalCaseReport) => void;
  abortSignal?: AbortSignal;
}
