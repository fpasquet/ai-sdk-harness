import type { HarnessV1NetworkSandboxSession } from '@ai-sdk/harness';
import type { HarnessAgentSession } from '@ai-sdk/harness/agent';
import type { ToolApprovalResponse, UIMessage, UIMessageChunk } from 'ai';

import { createUIMessageStream } from 'ai';

import type { EvalAgent, EvalStreamResult } from '../src/index.js';

/** What one stream of the fake agent does: the chunks it writes between `start` and `finish`. */
export interface ScriptedStream {
  chunks?: UIMessageChunk[];
  /** Streams nothing until the turn is aborted: a turn that never ends. */
  hang?: boolean;
  /** The stream fails with it. */
  fail?: Error;
}

let ids = 0;
const nextId = (): string => `call-${(ids += 1)}`;

/** An answer in text. */
export const say = (text: string): UIMessageChunk[] => {
  const id = nextId();
  return [
    { type: 'text-start', id },
    { type: 'text-delta', id, delta: text },
    { type: 'text-end', id },
  ];
};

/** A call of a tool, that completes with `output`. */
export const call = (
  toolName: string,
  input: unknown,
  output: unknown = 'ok',
): UIMessageChunk[] => {
  const toolCallId = nextId();
  return [
    { type: 'tool-input-available', toolCallId, toolName, input, dynamic: true },
    { type: 'tool-output-available', toolCallId, output, dynamic: true },
  ];
};

/** A call of a tool, that fails with `errorText`. */
export const fail = (toolName: string, input: unknown, errorText: string): UIMessageChunk[] => {
  const toolCallId = nextId();
  return [
    { type: 'tool-input-available', toolCallId, toolName, input, dynamic: true },
    { type: 'tool-output-error', toolCallId, errorText, dynamic: true },
  ];
};

/** A call of a tool that waits for an approval, and what to stream once it is answered. */
export const ask = (
  toolName: string,
  input: unknown,
): { toolCallId: string; approvalId: string; chunks: UIMessageChunk[] } => {
  const toolCallId = nextId();
  const approvalId = `approval-${toolCallId}`;
  return {
    toolCallId,
    approvalId,
    chunks: [
      { type: 'tool-input-available', toolCallId, toolName, input, dynamic: true },
      { type: 'tool-approval-request', approvalId, toolCallId },
    ],
  };
};

/** An agent whose streams follow a script, with what it was asked kept for the tests to read. */
export class FakeAgent implements EvalAgent {
  readonly prompts: string[] = [];
  readonly continuations: (readonly ToolApprovalResponse[] | undefined)[] = [];
  readonly sessions: { id: string; destroyed: boolean }[] = [];
  /** The next streams, in order; an empty script answers `ok`. */
  script: ScriptedStream[] = [];
  /** Makes `createSession` fail with it. */
  failStart?: Error;

  createSession = (options: {
    sessionId?: string;
    sandboxSession: HarnessV1NetworkSandboxSession;
  }): Promise<HarnessAgentSession> => {
    if (this.failStart !== undefined) return Promise.reject(this.failStart);
    const record = { id: options.sessionId ?? 'session', destroyed: false };
    this.sessions.push(record);
    return Promise.resolve({
      id: record.id,
      destroy: () => {
        record.destroyed = true;
        return Promise.resolve();
      },
    } as unknown as HarnessAgentSession);
  };

  stream = (options: { prompt: string; abortSignal?: AbortSignal }): Promise<EvalStreamResult> => {
    this.prompts.push(options.prompt);
    return Promise.resolve(this.next(options.abortSignal));
  };

  continueStream = (options: {
    toolApprovalContinuations?: readonly ToolApprovalResponse[];
    abortSignal?: AbortSignal;
  }): Promise<EvalStreamResult> => {
    this.continuations.push(options.toolApprovalContinuations);
    return Promise.resolve(this.next(options.abortSignal));
  };

  private next(abortSignal?: AbortSignal): EvalStreamResult {
    const scripted = this.script.shift() ?? { chunks: say('ok') };
    return {
      totalUsage: Promise.resolve({
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
      }) as unknown as EvalStreamResult['totalUsage'],
      toUIMessageStream: ((options: {
        originalMessages: UIMessage[];
        generateMessageId: () => string;
        onFinish: (event: { messages: UIMessage[] }) => void;
        onError: (error: unknown) => string;
      }) =>
        createUIMessageStream({
          originalMessages: options.originalMessages,
          generateId: options.generateMessageId,
          onFinish: options.onFinish,
          onError: options.onError,
          execute: async ({ writer }) => {
            if (scripted.hang === true) {
              await new Promise((_, reject) => {
                abortSignal?.addEventListener('abort', () => reject(abortSignal.reason as Error));
              });
            }
            if (scripted.fail !== undefined) throw scripted.fail;
            writer.write({ type: 'start' });
            for (const chunk of scripted.chunks ?? []) writer.write(chunk);
            writer.write({ type: 'finish' });
          },
        })) as EvalStreamResult['toUIMessageStream'],
    };
  }
}

/** The sandbox the fake agent is given: it never touches it. */
export const sandbox = { id: 'sandbox' } as unknown as HarnessV1NetworkSandboxSession;
