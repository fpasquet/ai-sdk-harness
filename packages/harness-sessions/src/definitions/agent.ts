import type { HarnessV1NetworkSandboxSession } from '@ai-sdk/harness';
import type { HarnessAgentResumeSessionState, HarnessAgentSession } from '@ai-sdk/harness/agent';
import type { StreamTextResult, ToolApprovalResponse, ToolResultPart, ToolSet } from 'ai';

/** A turn's result, whatever the agent's runtime context and output. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- any context, any output
type AnyStreamTextResult = StreamTextResult<ToolSet, any, any>;

/** What the manager reads of a turn: a `StreamTextResult` is one. */
export type SessionStreamResult = Pick<AnyStreamTextResult, 'totalUsage' | 'toUIMessageStream'>;

/**
 * What the manager needs of an agent: a `HarnessAgent` is one, whatever its harness, tools and
 * settings.
 */
export interface SessionAgent {
  createSession(options: {
    sessionId: string;
    sandboxSession: HarnessV1NetworkSandboxSession;
    resumeFrom?: HarnessAgentResumeSessionState;
    abortSignal?: AbortSignal;
  }): Promise<HarnessAgentSession>;
  stream(options: {
    session: HarnessAgentSession;
    prompt: string;
    abortSignal?: AbortSignal;
  }): PromiseLike<SessionStreamResult>;
  continueStream(options: {
    session: HarnessAgentSession;
    toolApprovalContinuations?: readonly ToolApprovalResponse[];
    toolResultContinuations?: readonly ToolResultPart[];
    abortSignal?: AbortSignal;
  }): PromiseLike<SessionStreamResult>;
}
