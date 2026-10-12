import type { HarnessV1NetworkSandboxSession } from '@ai-sdk/harness';
import type { HarnessAgentResumeSessionState, HarnessAgentSession } from '@ai-sdk/harness/agent';

/** A harness session of the fake agent. */
/** A harness session of the fake agent: what the manager reads of one. */
export class FakeHandle implements Pick<
  HarnessAgentSession,
  'destroy' | 'hasUnfinishedTurn' | 'stop'
> {
  unfinished = false;
  stopped = false;
  destroyed = false;
  failStop = false;

  constructor(
    readonly sessionId: string,
    readonly sandboxSession: HarnessV1NetworkSandboxSession,
    readonly resumeFrom: HarnessAgentResumeSessionState | undefined,
  ) {
    // Resumed with its unfinished turn, as a harness session is.
    this.unfinished = resumeFrom?.continueFrom !== undefined;
  }

  hasUnfinishedTurn(): boolean {
    return this.unfinished;
  }

  stop = (): Promise<HarnessAgentResumeSessionState> => {
    if (this.failStop) return Promise.reject(new Error('cannot stop'));
    this.stopped = true;
    return Promise.resolve(resumeState(this.sessionId, this.unfinished));
  };

  destroy = (): Promise<void> => {
    this.destroyed = true;
    return Promise.resolve();
  };
}

export const resumeState = (
  sessionId: string,
  unfinished = false,
): HarnessAgentResumeSessionState => ({
  type: 'resume-session',
  harnessId: 'fake',
  specificationVersion: 'harness-v1',
  // A bridge-backed harness keeps where the bridge of an unfinished turn listens.
  data: { sessionId, ...(unfinished && { bridge: { port: 4001 } }) },
  ...(unfinished && {
    continueFrom: {
      type: 'continue-turn',
      harnessId: 'fake',
      specificationVersion: 'harness-v1',
      data: {},
    },
  }),
});
