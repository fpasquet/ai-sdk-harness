import type { LanguageModelUsage, UIMessage, UIMessageChunk } from 'ai';

import type { SessionStreamResult } from '../definitions/agent.js';

/** How a turn ended. */
export interface TurnOutcome {
  /** The conversation with the turn's answer, when the stream got far enough to give it. */
  messages: UIMessage[] | undefined;
  /** What went wrong, when the turn failed or was cut short. */
  failure: string | undefined;
  usage: LanguageModelUsage | undefined;
}

export interface TurnStreamOptions {
  /** The conversation the turn adds to: its last message is the one the turn answers. */
  originalMessages: UIMessage[];
  generateMessageId: () => string;
  /** What the client is told of an error; the outcome keeps its real message. */
  errorMessage: (error: unknown) => string;
  /** Runs once, when the turn is over, before the client's stream closes when it can. */
  onSettled: (outcome: TurnOutcome) => Promise<void>;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * The turn as a UI message stream, for the client, while this side reads it to its end as well: a
 * client that goes away does not leave the turn hanging, and the outcome is settled either way.
 */
export function streamTurn(
  result: SessionStreamResult,
  options: TurnStreamOptions,
): { stream: ReadableStream<UIMessageChunk>; settled: Promise<void> } {
  let messages: UIMessage[] | undefined;
  let failure: string | undefined;
  let settled: Promise<void> | undefined;
  const settle = (): Promise<void> => {
    settled ??= (async () => {
      const usage = await Promise.resolve(result.totalUsage).catch(() => undefined);
      await options.onSettled({ messages, failure, usage });
    })();
    return settled;
  };

  const [toClient, toServer] = result
    .toUIMessageStream<UIMessage>({
      originalMessages: options.originalMessages,
      // Without it, a turn that continues a message the client cannot tell apart from the others.
      generateMessageId: options.generateMessageId,
      // Awaited before the stream closes: the client reads the session once it is settled.
      onFinish: async ({ messages: finished }) => {
        messages = finished;
        await settle();
      },
      // Called again with the text it returned, as the error chunk is read: the first is the one.
      onError: (error) => {
        failure ??= messageOf(error);
        return options.errorMessage(error);
      },
    })
    .tee();

  const drained = (async () => {
    const reader = toServer.getReader();
    try {
      while (!(await reader.read()).done);
    } catch (error) {
      failure ??= messageOf(error);
    } finally {
      await settle();
    }
  })();

  return { stream: toClient, settled: drained };
}
