import type { HarnessAgentSession } from '@ai-sdk/harness/agent';
import type { ToolApprovalResponse, UIMessage } from 'ai';

import { generateId } from 'ai';

import type {
  EvalAgent,
  EvalApprovals,
  EvalRun,
  EvalSandboxes,
  EvalSandboxLease,
  EvalStreamResult,
  EvalTurn,
} from '../definitions/eval.js';

import { messageOf } from '../utils/text.js';
import { skillsLoadedBy } from '../utils/tool-names.js';
import { pendingApprovalsOf, textOf, toolCallsOf, withAnswers } from './read-messages.js';

/** The most streams a turn may run, approvals answered in between: past it, the agent loops. */
const MAX_STREAMS_PER_TURN = 50;

export interface TrialOptions {
  agent: EvalAgent;
  sandboxes: EvalSandboxes;
  /** The prompts of the turns, `/commands` expanded already. */
  prompts: readonly string[];
  approvals: EvalApprovals;
  abortSignal: AbortSignal;
}

/** What a trial observed: an `EvalRun` before its checks. */
export type TrialObservation = Omit<EvalRun, 'checks' | 'passed' | 'score'>;

/** The turns of one trial, in one session of the agent. */
class Trial {
  readonly usage: EvalRun['usage'] = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  readonly turns: EvalTurn[] = [];
  messages: UIMessage[] = [];

  constructor(private readonly options: TrialOptions) {}

  /**
   * Runs the turns in a new session of the agent, destroyed at the end; gives what kept the trial
   * from its end, if anything did.
   */
  async run(): Promise<string | undefined> {
    const { agent, sandboxes, abortSignal } = this.options;
    const sessionId = `eval-${generateId()}`;
    let lease: EvalSandboxLease | undefined;
    let session: HarnessAgentSession | undefined;
    try {
      lease = await sandboxes.acquire(sessionId, { resume: false, abortSignal });
      session = await agent.createSession({
        sessionId,
        sandboxSession: lease.sandboxSession,
        abortSignal,
      });
      for (const prompt of this.options.prompts) await this.turn(session, prompt);
      return undefined;
    } catch (caught) {
      return abortSignal.aborted ? `Timed out: ${messageOf(caught)}` : messageOf(caught);
    } finally {
      await session?.destroy().catch(() => undefined);
      await lease?.close().catch(() => undefined);
    }
  }

  /** What the trial observed, whether it ran to its end or `error` stopped it. */
  observation(durationMs: number, error: string | undefined): TrialObservation {
    const toolCalls = this.turns.flatMap((turn) => turn.toolCalls);
    return {
      text: this.turns.at(-1)?.text ?? '',
      turns: this.turns,
      toolCalls,
      skills: [...new Set(toolCalls.flatMap(({ name, input }) => skillsLoadedBy(name, input)))],
      messages: this.messages,
      usage: this.usage,
      durationMs,
      ...(error !== undefined && { error }),
    };
  }

  /** Runs one turn: its first stream, then one more for each pause on approvals. */
  private async turn(session: HarnessAgentSession, prompt: string): Promise<void> {
    const { agent, abortSignal } = this.options;
    const before = this.messages.length;
    const user: UIMessage = {
      id: generateId(),
      role: 'user',
      parts: [{ type: 'text', text: prompt }],
    };
    await this.read(await agent.stream({ session, prompt, abortSignal }), [...this.messages, user]);
    for (let streams = 1; ; streams += 1) {
      const responses = this.answers();
      if (responses.length === 0) break;
      if (streams >= MAX_STREAMS_PER_TURN) {
        throw new Error(`The turn still waits for approvals after ${streams} streams.`);
      }
      await this.read(
        await agent.continueStream({ session, toolApprovalContinuations: responses, abortSignal }),
        withAnswers(this.messages, responses),
      );
    }
    // The turn's answer: what follows its prompt.
    const answer = this.messages.slice(before + 1);
    const index = this.turns.length;
    this.turns.push({ prompt, text: textOf(answer), toolCalls: toolCallsOf(answer, index) });
  }

  /** The answers to the approvals the last message waits for. */
  private answers(): ToolApprovalResponse[] {
    const approved = this.options.approvals === 'approve';
    return pendingApprovalsOf(this.messages).map((approvalId) => ({
      type: 'tool-approval-response',
      approvalId,
      approved,
      ...(!approved && { reason: 'Denied by the eval.' }),
    }));
  }

  /** Reads one stream of a turn to its end, and keeps the conversation it ends with. */
  private async read(result: EvalStreamResult, originalMessages: UIMessage[]): Promise<void> {
    let finished: UIMessage[] | undefined;
    let failure: string | undefined;
    const stream = result.toUIMessageStream<UIMessage>({
      originalMessages,
      generateMessageId: generateId,
      onFinish: ({ messages }) => {
        finished = messages;
      },
      // Called again with the text it returned, as the error chunk is read: the first is the one.
      onError: (error) => (failure ??= messageOf(error)),
    });
    for await (const chunk of stream) {
      if (chunk.type === 'error') failure ??= chunk.errorText;
    }
    const spent = await Promise.resolve(result.totalUsage).catch(() => undefined);
    for (const key of ['inputTokens', 'outputTokens', 'totalTokens'] as const) {
      this.usage[key] = (this.usage[key] ?? 0) + (spent?.[key] ?? 0);
    }
    if (failure !== undefined) throw new Error(failure);
    this.messages = finished ?? originalMessages;
  }
}

/**
 * Runs the turns of one trial in a new session of the agent, destroyed at the end: what the agent
 * answered and did, or what kept the trial from its end.
 */
export async function runTrial(options: TrialOptions): Promise<TrialObservation> {
  const started = Date.now();
  const trial = new Trial(options);
  const error = await trial.run();
  return trial.observation(Date.now() - started, error);
}
