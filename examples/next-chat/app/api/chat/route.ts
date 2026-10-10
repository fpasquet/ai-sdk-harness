import type { UIMessage } from 'ai';

import { getHarnessErrorMessage } from '@ai-sdk/harness/agent';
import { expandCommand, InvalidPluginError } from 'ai-sdk-harness-plugins';

import type { Conversation } from '@/lib/conversations';

import { titleOf } from '@/lib/conversations';
import { HARNESSES, isKnown } from '@/lib/harnesses';
import { errorResponse } from '@/lib/http';
import { resolveSelection } from '@/lib/plugins';
import { sessions } from '@/lib/sessions';

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
 * turn continues.
 */
export async function POST(request: Request): Promise<Response> {
  const { id, messages, ...picked } = (await request.json()) as ChatRequest;
  const manager = sessions();
  const last = messages.at(-1);
  try {
    const metadata = (await manager.get(id))?.metadata ?? (await open(id, picked, last));
    if (metadata === undefined)
      return new Response('Unknown coding agent or model.', { status: 400 });

    const turn = await (last?.role === 'assistant'
      ? manager.continue(id, { message: last, abortSignal: request.signal })
      : reply(id, { metadata, message: last, abortSignal: request.signal }));
    return turn.toUIMessageStreamResponse();
  } catch (error) {
    if (InvalidPluginError.isInstance(error)) return new Response(error.message, { status: 400 });
    return errorResponse(error, getHarnessErrorMessage);
  }
}

/** Sends the user's message, expanded first when it calls a command of the plugins. */
async function reply(
  id: string,
  {
    abortSignal,
    message,
    metadata,
  }: { abortSignal: AbortSignal; message: UIMessage | undefined; metadata: Conversation },
) {
  const text = textOf(message);
  const { plugins } = await resolveSelection(metadata.selection);
  const prompt = expandCommand(text, plugins)?.prompt ?? text;
  return sessions().send(id, { message: message ?? text, prompt, abortSignal });
}

/**
 * Opens the session of a new conversation, with the agent it picked; `undefined` when the coding
 * agent or the model is not one of the example's.
 */
async function open(
  id: string,
  picked: Omit<ChatRequest, 'id' | 'messages'>,
  first: UIMessage | undefined,
): Promise<Conversation | undefined> {
  if (!isKnown(picked.harness, picked.model)) return undefined;
  const metadata: Conversation = {
    harness: picked.harness,
    model: picked.model as string,
    selection: Array.isArray(picked.selection) ? picked.selection.map(String) : [],
    askFirst: picked.askFirst === true && HARNESSES[picked.harness].asksFirst,
    title: titleOf(textOf(first)),
  };
  // Refused here rather than in the background: an id the marketplace does not have.
  await resolveSelection(metadata.selection);
  await sessions().create({ id, metadata });
  return metadata;
}
