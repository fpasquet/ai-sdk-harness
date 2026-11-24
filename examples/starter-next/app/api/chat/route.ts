import type { UIMessage } from 'ai';

import { sessions } from '@/lib/sessions';

// A turn reads files, runs commands and edits code: give it time.
export const maxDuration = 300;

/**
 * One turn of a conversation. Its first message opens a session; the session keeps the
 * conversation, so only the new message goes to the agent. Closing the page, or the stop button,
 * aborts the request, and the turn with it.
 */
export async function POST(request: Request): Promise<Response> {
  const { id, messages } = (await request.json()) as { id: string; messages: UIMessage[] };
  const message = messages.at(-1);
  if (message === undefined) return new Response('No message.', { status: 400 });

  const manager = sessions();
  if ((await manager.get(id)) === undefined) await manager.create({ id, metadata: {} });
  const turn = await manager.send(id, { message, abortSignal: request.signal });
  return turn.toUIMessageStreamResponse();
}
