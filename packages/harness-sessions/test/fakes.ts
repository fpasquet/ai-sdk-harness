import type { HarnessV1NetworkSandboxSession } from '@ai-sdk/harness';
import type { HarnessAgentResumeSessionState, HarnessAgentSession } from '@ai-sdk/harness/agent';
import type { ToolApprovalResponse, ToolResultPart, UIMessage, UIMessageChunk } from 'ai';

import { createUIMessageStream } from 'ai';

import type { SessionAgent, SessionSandboxes, SessionStreamResult } from '../src/index.js';

import { FakeHandle } from './fake-handle.js';

export { FakeHandle, resumeState } from './fake-handle.js';

/** What a turn of the fake agent does. */
export interface ScriptedTurn {
  /** The answer, as text. Default: `ok`. */
  text?: string;
  /** Chunks streamed after the text: a tool call, an approval request… */
  chunks?: UIMessageChunk[];
  /** Leave the turn unfinished, waiting for input. */
  unfinished?: boolean;
  /** Streams nothing until it settles: a turn under way. Aborting the turn rejects it. */
  hold?: Promise<void>;
  /** The stream fails with it. */
  fail?: Error;
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
}

/** An agent whose turns follow a script, with what it was asked kept for the tests to read. */
export class FakeAgent implements SessionAgent {
  readonly handles: FakeHandle[] = [];
  readonly prompts: string[] = [];
  readonly continuations: {
    toolApprovalContinuations?: readonly ToolApprovalResponse[];
    toolResultContinuations?: readonly ToolResultPart[];
  }[] = [];
  /** The next turns, in order; an empty script answers `ok`. */
  readonly script: ScriptedTurn[] = [];
  /** Makes `createSession` fail with it. */
  failStart?: Error;
  /** Makes `stream` and `continueStream` throw it before any stream. */
  failTurn?: Error;

  createSession = (options: {
    sessionId: string;
    sandboxSession: HarnessV1NetworkSandboxSession;
    resumeFrom?: HarnessAgentResumeSessionState;
  }): Promise<HarnessAgentSession> => {
    if (this.failStart !== undefined) return Promise.reject(this.failStart);
    const handle = new FakeHandle(options.sessionId, options.sandboxSession, options.resumeFrom);
    this.handles.push(handle);
    return Promise.resolve(handle as unknown as HarnessAgentSession);
  };

  stream = (options: {
    session: HarnessAgentSession;
    prompt: string;
    abortSignal?: AbortSignal;
  }): Promise<SessionStreamResult> => {
    this.prompts.push(options.prompt);
    return this.turn(options.session as unknown as FakeHandle, options.abortSignal);
  };

  continueStream = ({
    session,
    abortSignal,
    ...responses
  }: {
    session: HarnessAgentSession;
    toolApprovalContinuations?: readonly ToolApprovalResponse[];
    toolResultContinuations?: readonly ToolResultPart[];
    abortSignal?: AbortSignal;
  }): Promise<SessionStreamResult> => {
    this.continuations.push(responses);
    return this.turn(session as unknown as FakeHandle, abortSignal);
  };

  private turn(handle: FakeHandle, abortSignal?: AbortSignal): Promise<SessionStreamResult> {
    if (this.failTurn !== undefined) return Promise.reject(this.failTurn);
    const turn = this.script.shift() ?? {};
    const usage = turn.usage ?? { inputTokens: 1, outputTokens: 2, totalTokens: 3 };
    const result: SessionStreamResult = {
      totalUsage: Promise.resolve(usage) as unknown as SessionStreamResult['totalUsage'],
      toUIMessageStream: ((options: {
        originalMessages: UIMessage[];
        generateMessageId: () => string;
        onFinish: (event: { messages: UIMessage[] }) => Promise<void>;
        onError: (error: unknown) => string;
      }) =>
        createUIMessageStream({
          originalMessages: options.originalMessages,
          generateId: options.generateMessageId,
          onFinish: options.onFinish,
          onError: options.onError,
          execute: async ({ writer }) => {
            if (turn.hold !== undefined) {
              await new Promise<void>((resolve, reject) => {
                abortSignal?.addEventListener('abort', () => reject(abortSignal.reason as Error));
                void turn.hold!.then(resolve);
              });
            }
            if (turn.fail !== undefined) throw turn.fail;
            writer.write({ type: 'start' });
            writer.write({ type: 'text-start', id: 't' });
            writer.write({ type: 'text-delta', id: 't', delta: turn.text ?? 'ok' });
            writer.write({ type: 'text-end', id: 't' });
            for (const chunk of turn.chunks ?? []) writer.write(chunk);
            writer.write({ type: 'finish' });
            handle.unfinished = turn.unfinished ?? false;
          },
        })) as SessionStreamResult['toUIMessageStream'],
    };
    return Promise.resolve(result);
  }
}

/** Sandboxes that only record what the manager asks of them. */
export function fakeSandboxes(capacity?: number): {
  events: string[];
  sandboxes: SessionSandboxes;
  failAcquire: { error?: Error };
} {
  const events: string[] = [];
  const failAcquire: { error?: Error } = {};
  return {
    events,
    failAcquire,
    sandboxes: {
      ...(capacity !== undefined && { capacity }),
      acquire: (sessionId, { resume }) => {
        events.push(`acquire ${sessionId}${resume ? ' (resume)' : ''}`);
        if (failAcquire.error !== undefined) return Promise.reject(failAcquire.error);
        return Promise.resolve({
          sandboxSession: { id: `box-${sessionId}` } as HarnessV1NetworkSandboxSession,
          suspend: () => {
            events.push(`suspend ${sessionId}`);
            return Promise.resolve();
          },
          close: () => {
            events.push(`close ${sessionId}`);
            return Promise.resolve();
          },
        });
      },
      discard: (sessionId) => {
        events.push(`discard ${sessionId}`);
        return Promise.resolve();
      },
      shutdown: () => {
        events.push('shutdown');
        return Promise.resolve();
      },
    },
  };
}

/** Every chunk of a stream. */
export async function readAll<T>(stream: ReadableStream<T>): Promise<T[]> {
  const chunks: T[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

/** A promise and what settles it. */
export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => (resolve = settle));
  return { promise, resolve };
}

/** Resolves once `check` holds, polling every few milliseconds. */
export async function until(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for a condition.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
