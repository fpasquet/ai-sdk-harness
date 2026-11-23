import type { LanguageModelUsage, UIMessage, UIMessageChunk } from 'ai';

import type { SessionStreamResult } from '../definitions/agent.js';
import type { TurnStepReport } from '../definitions/session.js';

/** The tokens a turn used, added up over its streams. */
export type TurnUsage = Pick<LanguageModelUsage, 'inputTokens' | 'outputTokens' | 'totalTokens'>;

/** How a turn ended. */
export interface TurnOutcome {
  /** The conversation with the turn's answer, when the stream got far enough to give it. */
  messages: UIMessage[] | undefined;
  /** What went wrong, when the turn failed or was cut short. */
  failure: string | undefined;
  usage: TurnUsage;
  /** The turn's tokens in detail, its steps, the raw events of its harness and its retries. */
  report: {
    usage: LanguageModelUsage;
    steps: TurnStepReport[];
    rawEvents: unknown[];
    retries: number;
  };
}

/** How a turn that failed is run again: what the manager decides, the stream follows. */
export interface TurnRetry {
  /**
   * The chunk telling the client the turn runs again, and how long it waits first, for this
   * retry (counted from 1) after `error`; `undefined` when the turn fails there.
   */
  plan: (error: unknown, attempt: number) => undefined | { chunk: UIMessageChunk; delayMs: number };
  /** The stream that carries the turn on, once the delay is over; `undefined` when it cannot. */
  resume: (error: unknown, attempt: number) => Promise<SessionStreamResult | undefined>;
  /** The turn's signal: a turn cut short is not run again. */
  abortSignal: AbortSignal;
}

/**
 * What a turn does once one of its streams ends: answers given in between, sent to the client and
 * written into the conversation, and the stream that continues the turn, if it goes on.
 */
export interface TurnStep {
  chunks: UIMessageChunk[];
  messages: UIMessage[];
  result?: SessionStreamResult;
}

export interface TurnStreamOptions {
  /** The conversation the turn adds to: its last message is the one the turn answers. */
  originalMessages: UIMessage[];
  generateMessageId: () => string;
  /** What the client is told of an error; the outcome keeps its real message. */
  errorMessage: (error: unknown) => string;
  /** What follows a stream of the turn that ended with its conversation. Default: the turn ends. */
  next?: (messages: UIMessage[]) => Promise<TurnStep | undefined>;
  /** Runs once, when the turn is over, before the client's stream closes. */
  onSettled: (outcome: TurnOutcome) => Promise<void>;
  /** Runs the turn again after an error, as it says. Default: a turn fails on its first error. */
  retry?: TurnRetry;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

interface SegmentOutcome {
  messages: UIMessage[] | undefined;
  failure: string | undefined;
  /** The error itself, for a retry to judge. */
  error: unknown;
  /** Its error chunks, held back while a retry may take the error's place. */
  errors: UIMessageChunk[];
  /** The stream's `finish` chunk, held back until the turn is over. */
  finish: UIMessageChunk | undefined;
  /**
   * Its approval requests, held back until `next` answered them: a client never shows the buttons
   * of an approval the manager answers.
   */
  requests: UIMessageChunk[];
}

/** Reads one stream of the turn to its end, sending its chunks on. */
async function readSegment(
  result: SessionStreamResult,
  originalMessages: UIMessage[],
  { send, options }: { send: (chunk: UIMessageChunk) => void; options: TurnStreamOptions },
): Promise<SegmentOutcome> {
  const outcome: SegmentOutcome = {
    messages: undefined,
    failure: undefined,
    error: undefined,
    errors: [],
    finish: undefined,
    requests: [],
  };
  const holding = options.next !== undefined;
  // The first error is the one: the stream's own `onError` is called again with its text.
  const fail = (error: unknown) => {
    if (outcome.failure !== undefined) return;
    outcome.failure = messageOf(error);
    outcome.error = error;
  };
  const reader = result
    .toUIMessageStream<UIMessage>({
      originalMessages,
      // Without it, a turn that continues a message the client cannot tell apart from the others.
      generateMessageId: options.generateMessageId,
      onFinish: ({ messages }) => {
        outcome.messages = messages;
      },
      // Called again with the text it returned, as the error chunk is read: the first is the one.
      onError: (error) => {
        fail(error);
        return options.errorMessage(error);
      },
    })
    .getReader();
  try {
    for (let read = await reader.read(); !read.done; read = await reader.read()) {
      const chunk = read.value;
      if (chunk.type === 'finish') outcome.finish = chunk;
      else if (options.retry !== undefined && chunk.type === 'error') outcome.errors.push(chunk);
      else if (holding && chunk.type === 'tool-approval-request') outcome.requests.push(chunk);
      else send(chunk);
    }
  } catch (error) {
    fail(error);
  }
  return outcome;
}

/** Tokens of nothing yet: what the turn's tokens are added to. */
function emptyUsage(): LanguageModelUsage {
  return {
    inputTokens: 0,
    inputTokenDetails: { noCacheTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    outputTokens: 0,
    outputTokenDetails: { textTokens: 0, reasoningTokens: 0 },
    totalTokens: 0,
  };
}

const add = (a: number | undefined, b: number | undefined) =>
  a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);

/** `total` plus `spent`, detail by detail: a count neither of them knows stays unknown. */
function addDetails(
  total: LanguageModelUsage,
  spent: LanguageModelUsage | undefined,
): LanguageModelUsage {
  if (spent === undefined) return total;
  return {
    inputTokens: add(total.inputTokens, spent.inputTokens),
    inputTokenDetails: {
      noCacheTokens: add(
        total.inputTokenDetails.noCacheTokens,
        spent.inputTokenDetails?.noCacheTokens,
      ),
      cacheReadTokens: add(
        total.inputTokenDetails.cacheReadTokens,
        spent.inputTokenDetails?.cacheReadTokens,
      ),
      cacheWriteTokens: add(
        total.inputTokenDetails.cacheWriteTokens,
        spent.inputTokenDetails?.cacheWriteTokens,
      ),
    },
    outputTokens: add(total.outputTokens, spent.outputTokens),
    outputTokenDetails: {
      textTokens: add(total.outputTokenDetails.textTokens, spent.outputTokenDetails?.textTokens),
      reasoningTokens: add(
        total.outputTokenDetails.reasoningTokens,
        spent.outputTokenDetails?.reasoningTokens,
      ),
    },
    totalTokens: add(total.totalTokens, spent.totalTokens),
  };
}

/** The steps of a stream of the turn: their model, tokens and tool calls. */
async function stepsOf(result: SessionStreamResult): Promise<TurnStepReport[]> {
  const steps = await Promise.resolve(result.steps).catch(() => undefined);
  return (steps ?? []).map((step) => ({
    modelId: step.response?.modelId,
    usage: step.usage,
    toolCalls: (step.toolCalls ?? []).map(({ toolCallId, toolName, input }) => ({
      toolCallId,
      toolName,
      input: input as unknown,
    })),
  }));
}

/**
 * The raw events a stream of the turn carries, read from its own copy of the stream, beside the
 * client's: what the harness sends that no other part says.
 */
async function rawEventsOf(result: SessionStreamResult): Promise<unknown[]> {
  const events: unknown[] = [];
  if (result.fullStream === undefined) return events;
  try {
    for await (const part of result.fullStream) {
      if (part.type === 'raw') events.push(part.rawValue);
    }
  } catch {
    // The turn's failure is told by the client's stream: the events read so far are kept.
  }
  return events;
}

/** Waits `ms`, or less when `signal` aborts. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

/** Adds the tokens a stream of the turn used, once it is over. */
async function addUsage(usage: TurnUsage, result: SessionStreamResult): Promise<void> {
  const spent = await Promise.resolve(result.totalUsage).catch(() => undefined);
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens'] as const) {
    usage[key] = (usage[key] ?? 0) + (spent?.[key] ?? 0);
  }
}

/** Runs a turn's streams one after the other, sending their chunks to the client. */
class TurnRun {
  private readonly usage: TurnUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  private details: LanguageModelUsage = emptyUsage();
  private readonly steps: TurnStepReport[] = [];
  private readonly rawEvents: unknown[] = [];
  private messages: UIMessage[] | undefined;
  private failure: string | undefined;
  private finish: UIMessageChunk | undefined;
  private retries = 0;
  private started = false;

  constructor(
    private readonly options: TurnStreamOptions,
    private readonly out: (chunk: UIMessageChunk) => void,
  ) {}

  /**
   * Sends a chunk to the client. The turn is one message there: a stream that continues it — after
   * approvals, or a retry — continues that message, opened by the first `start`.
   */
  private readonly send = (chunk: UIMessageChunk): void => {
    if (chunk.type === 'start') {
      if (this.started) return;
      this.started = true;
    }
    this.out(chunk);
  };

  async run(first: SessionStreamResult): Promise<TurnOutcome> {
    let result: SessionStreamResult | undefined = first;
    let originalMessages = this.options.originalMessages;
    while (result !== undefined) {
      const raw = rawEventsOf(result);
      const outcome = await readSegment(result, originalMessages, {
        send: this.send,
        options: this.options,
      });
      await addUsage(this.usage, result);
      const spent = await Promise.resolve(result.totalUsage).catch(() => undefined);
      this.details = addDetails(this.details, spent);
      const steps = await stepsOf(result);
      const events = await raw;
      this.steps.push(...steps);
      this.rawEvents.push(...events);
      this.finish = outcome.finish;
      this.messages = outcome.messages ?? this.messages;
      result = await this.retryAfter(outcome);
      if (result !== undefined) {
        // The turn carries on where the failed stream left it, in the client's message.
        originalMessages = this.messages ?? originalMessages;
        continue;
      }
      this.failure ??= outcome.failure;
      const step = await this.next(outcome.messages, outcome.requests);
      result = step?.result;
      if (step) originalMessages = this.messages = step.messages;
    }
    if (this.finish !== undefined) this.send(this.finish);
    return {
      messages: this.messages,
      failure: this.failure,
      usage: this.usage,
      report: {
        usage: this.details,
        steps: this.steps,
        rawEvents: this.rawEvents,
        retries: this.retries,
      },
    };
  }

  /**
   * The stream that runs the turn again after a stream that failed, as `retry` decides, the
   * client told first; `undefined` once it gives up. A retry that cannot start counts as one.
   */
  private async retryAfter(outcome: SegmentOutcome): Promise<SessionStreamResult | undefined> {
    if (outcome.failure === undefined) return undefined;
    const result = this.failure === undefined ? await this.retry(outcome) : undefined;
    // Given up: the client is told the error the retries were holding back.
    if (result === undefined) for (const chunk of outcome.errors) this.send(chunk);
    return result;
  }

  private async retry(outcome: SegmentOutcome): Promise<SessionStreamResult | undefined> {
    const { retry } = this.options;
    if (retry === undefined) return undefined;
    let error: unknown = outcome.error ?? new Error(outcome.failure);
    for (;;) {
      if (retry.abortSignal.aborted) return undefined;
      const planned = retry.plan(error, this.retries + 1);
      if (planned === undefined) return undefined;
      this.retries += 1;
      this.send(planned.chunk);
      await pause(planned.delayMs, retry.abortSignal);
      if (retry.abortSignal.aborted) return undefined;
      try {
        return await retry.resume(error, this.retries);
      } catch (failed) {
        error = failed;
        outcome.failure = messageOf(failed);
        outcome.errors = [{ type: 'error', errorText: this.options.errorMessage(failed) }];
      }
    }
  }

  /**
   * What follows a stream that ended well, its approval requests sent first, with the answers
   * `next` gave them; nothing after a failure.
   */
  private async next(
    messages: UIMessage[] | undefined,
    requests: UIMessageChunk[],
  ): Promise<TurnStep | undefined> {
    let step: TurnStep | undefined;
    let failed: unknown;
    if (this.failure === undefined && messages !== undefined && this.options.next) {
      try {
        step = await this.options.next(messages);
      } catch (error) {
        failed = error;
      }
    }
    for (const chunk of [...requests, ...(step?.chunks ?? [])]) this.send(chunk);
    if (failed !== undefined) {
      this.failure = messageOf(failed);
      this.send({ type: 'error', errorText: this.options.errorMessage(failed) });
    }
    return step;
  }
}

/**
 * The turn as a UI message stream for the client, read to its end on this side whether the client
 * reads it or not: a client that goes away does not leave the turn hanging, and the outcome is
 * settled either way. A turn may run several streams, one after the other, `next` deciding.
 */
export function streamTurn(
  first: SessionStreamResult,
  options: TurnStreamOptions,
): { stream: ReadableStream<UIMessageChunk>; settled: Promise<void> } {
  let controller!: ReadableStreamDefaultController<UIMessageChunk>;
  let reading = true;
  const stream = new ReadableStream<UIMessageChunk>({
    start: (opened) => {
      controller = opened;
    },
    cancel: () => {
      reading = false;
    },
  });
  const send = (chunk: UIMessageChunk) => {
    if (reading) controller.enqueue(chunk);
  };

  const settled = (async () => {
    try {
      const outcome = await new TurnRun(options, send).run(first);
      // Settled before the stream closes: the client reads the session once it is written.
      await options.onSettled(outcome);
    } finally {
      if (reading) controller.close();
    }
  })();

  return { stream, settled };
}
