import type { UIMessage } from 'ai';

import { expandCommand } from 'ai-sdk-harness-plugins';

import { plugin } from '@/lib/plugin';
import { sessions } from '@/lib/sessions';

// A turn reads files, runs commands and edits code: give it time.
export const maxDuration = 300;

const textOf = (message: UIMessage): string =>
  message.parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n');

/**
 * One turn of a conversation. Its first message opens a session; the session keeps the
 * conversation, so only the new message goes to the agent, `/review` expanded first. When the last
 * message is the agent's, you answered what it asked approval for: the paused turn goes on.
 */
export async function POST(request: Request): Promise<Response> {
  const { id, messages } = (await request.json()) as { id: string; messages: UIMessage[] };
  const message = messages.at(-1);
  if (message === undefined) return new Response('No message.', { status: 400 });

  const manager = sessions();
  if (message.role === 'assistant') {
    const turn = await manager.continue(id, { message });
    return turn.toUIMessageStreamResponse();
  }
  const text = textOf(message);
  if ((await manager.get(id)) === undefined) {
    await manager.create({ id, metadata: { title: text.slice(0, 60) } });
  }
  const prompt = expandCommand(text, [plugin])?.prompt ?? text;
  const turn = await manager.send(id, { message, prompt, abortSignal: request.signal });
  return turn.toUIMessageStreamResponse();
}
