import type { UIMessageChunk } from 'ai';

import type { TurnTimings } from '@/lib/conversations';

/** A sandbox the example opened: when, how, and how long it took. */
interface Opening {
  startedAt: number;
  kind: 'created' | 'resumed';
  ms: number;
}

// Kept on globalThis so `next dev` reloading this module keeps them.
const globals = globalThis as { __aiSdkExampleOpenings?: Opening[] };
const openings = (globals.__aiSdkExampleOpenings ??= []);

/** Opens a sandbox with `open`, and notes how long it took, for the turn that waited for it. */
export async function timedOpening<T extends { resumed: boolean }>(
  open: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  const opened = await open();
  openings.push({
    startedAt,
    kind: opened.resumed ? 'resumed' : 'created',
    ms: Date.now() - startedAt,
  });
  // Only the last few matter: a turn looks for the one it waited for.
  openings.splice(0, Math.max(0, openings.length - 20));
  return opened;
}

/**
 * The sandbox a turn that started at `since` waited for: the last one opened since. With several
 * conversations starting at once, one may be told of the other's: the example's timings are a
 * guide, not an audit.
 */
function openingSince(since: number): TurnTimings['sandbox'] {
  const opening = openings.findLast(({ startedAt }) => startedAt >= since);
  return opening && { kind: opening.kind, ms: opening.ms };
}

/** Whether a chunk is the agent's first output: words, thoughts or a tool call. */
const isOutput = (chunk: UIMessageChunk): boolean =>
  chunk.type === 'text-delta' ||
  chunk.type === 'reasoning-delta' ||
  chunk.type === 'tool-input-start';

/**
 * Times a turn: `receivedAt` when the server got the message, `readyAt` when its session was ready.
 * Returns the stream for the page, untouched; a copy of it is read here to its end, the page gone
 * or not, and `onTimed` then gets the timings and the id of the agent's message, read from the
 * stream or else `messageId`, the message a continued turn adds to.
 */
export function timeTurn(
  stream: ReadableStream<UIMessageChunk>,
  {
    messageId,
    onTimed,
    readyAt,
    receivedAt,
  }: {
    messageId: string | undefined;
    onTimed: (messageId: string, timings: TurnTimings) => void;
    readyAt: number;
    receivedAt: number;
  },
): ReadableStream<UIMessageChunk> {
  const [page, timed] = stream.tee();
  void (async () => {
    let id = messageId;
    let firstOutputAt: number | undefined;
    for await (const chunk of timed) {
      if (chunk.type === 'start' && chunk.messageId !== undefined) id = chunk.messageId;
      if (firstOutputAt === undefined && isOutput(chunk)) firstOutputAt = Date.now();
    }
    if (id === undefined) return;
    const endedAt = Date.now();
    onTimed(id, {
      sandbox: openingSince(receivedAt),
      ready: readyAt - receivedAt,
      firstOutput: firstOutputAt === undefined ? undefined : firstOutputAt - readyAt,
      turn: endedAt - readyAt,
      total: endedAt - receivedAt,
    });
  })().catch(() => undefined);
  return page;
}
