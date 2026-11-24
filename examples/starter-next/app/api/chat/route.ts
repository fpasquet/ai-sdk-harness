import type { UIMessage } from 'ai';

import { createUIMessageStreamResponse } from 'ai';
import { expandCommand, InvalidPluginError } from 'ai-sdk-harness-plugins';

import type { Conversation, TurnTimings } from '@/lib/conversations';

import { titleOf } from '@/lib/conversations';
import { harnessAvailability } from '@/lib/harness-adapters';
import { HARNESS_IDS, HARNESSES, isKnown } from '@/lib/harnesses';
import { errorResponse } from '@/lib/http';
import { openRouterModelsFor } from '@/lib/models';
import { resolveSelection } from '@/lib/plugins';
import { ExampleConfigurationError, SANDBOX } from '@/lib/sandbox';
import { sessions } from '@/lib/sessions';
import { timeTurn } from '@/lib/timings';

// A turn reads files, runs commands and edits code: give it time.
export const maxDuration = 300;

interface ChatRequest {
  id: string;
  messages: UIMessage[];
  harness?: unknown;
  model?: unknown;
  /** The ids of what the conversation picked in the marketplace. */
  selection?: unknown;
  askFirst?: unknown;
}

const textOf = (message: UIMessage | undefined): string =>
  (message?.parts ?? []).flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n');

/**
 * One turn of a conversation, a session of `ai-sdk-harness-sessions`. Its first message opens the
 * session, with the agent it picked; the session keeps the conversation, so only the new message
 * is sent to the agent — expanded first when it calls a command of the plugins, `/explain src`.
 * When the last message is the agent's, the user answered what it asked approval for: the paused
 * turn continues. The turn is timed, from this request to its end, and its timings kept with the
 * conversation for the page to show under the agent's answer. It goes on when the page is closed,
 * up to `EXAMPLE_TURN_TIMEOUT_MS`: the stop button interrupts it (`/api/sessions/<id>/interrupt`).
 */
export async function POST(request: Request): Promise<Response> {
  const receivedAt = Date.now();
  const { id, messages, ...picked } = (await request.json()) as ChatRequest;
  const manager = sessions();
  const last = messages.at(-1);
  try {
    const metadata = (await manager.get(id))?.metadata ?? (await open(id, picked, last));
    if (metadata === undefined)
      return new Response('Unknown coding agent or model.', { status: 400 });

    const continued = last?.role === 'assistant';
    const turn = await (continued
      ? manager.continue(id, { message: last })
      : reply(id, { metadata, message: last }));
    const stream = timeTurn(turn.stream, {
      receivedAt,
      readyAt: Date.now(),
      messageId: continued ? last.id : undefined,
      // Once the turn is written: the conversation then takes its timings.
      onTimed: (messageId, timings) =>
        void turn.done.then(() => keepTimings(id, messageId, timings)).catch(() => undefined),
    });
    return createUIMessageStreamResponse({ stream });
  } catch (error) {
    if (InvalidPluginError.isInstance(error)) return new Response(error.message, { status: 400 });
    return errorResponse(error);
  }
}

/** Keeps the timings of a turn with its conversation, by the id of the agent's message. */
async function keepTimings(id: string, messageId: string, timings: TurnTimings): Promise<void> {
  await sessions().update(id, {
    metadata: (metadata) => ({
      ...metadata,
      timings: { ...metadata.timings, [messageId]: timings },
    }),
  });
}

/** Sends the user's message, expanded first when it calls a command of the plugins. */
async function reply(
  id: string,
  { message, metadata }: { message: UIMessage | undefined; metadata: Conversation },
) {
  const text = textOf(message);
  const { plugins } = await resolveSelection(metadata.selection);
  const prompt = expandCommand(text, plugins)?.prompt ?? text;
  return sessions().send(id, { message: message ?? text, prompt });
}

/**
 * Opens the session of a new conversation, with the agent it picked; `undefined` when the coding
 * agent or the model is not one of the example's. A coding agent without its credential is
 * refused, with the variables to set.
 */
async function open(
  id: string,
  picked: Omit<ChatRequest, 'id' | 'messages'>,
  first: UIMessage | undefined,
): Promise<Conversation | undefined> {
  const harness = HARNESS_IDS.find((id) => id === picked.harness);
  const catalog = await openRouterModelsFor(harness === undefined ? [] : [harness]);
  if (!isKnown(picked.harness, picked.model, catalog)) return undefined;
  if (!harnessAvailability()[picked.harness]) {
    const { credentials, label } = HARNESSES[picked.harness];
    throw new ExampleConfigurationError(`${label} needs ${credentials}: see .env.example.`);
  }
  const metadata: Conversation = {
    harness: picked.harness,
    model: picked.model as string,
    selection: Array.isArray(picked.selection) ? picked.selection.map(String) : [],
    askFirst: picked.askFirst === true && HARNESSES[picked.harness].asksFirst,
    title: titleOf(textOf(first)),
    sandbox: SANDBOX,
  };
  // Refused here rather than in the background: an id the marketplace does not have.
  await resolveSelection(metadata.selection);
  await sessions().create({ id, metadata });
  return metadata;
}
