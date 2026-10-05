import type { UIMessage } from 'ai';

import { getHarnessErrorMessage } from '@ai-sdk/harness/agent';

import { agentFor, sessionFor } from '@/lib/agent';
import { isKnown } from '@/lib/harnesses';

// A turn reads files, runs commands and edits code: give it time.
export const maxDuration = 300;

interface ChatRequest {
  id: string;
  messages: UIMessage[];
  harness?: unknown;
  model?: unknown;
}

/**
 * One turn of the conversation, with the harness and the model it was started with. The coding
 * agent keeps the conversation itself, in its session: only the new user message is sent to it.
 */
export async function POST(request: Request): Promise<Response> {
  const { id, messages, harness, model } = (await request.json()) as ChatRequest;
  if (!isKnown(harness, model)) {
    return new Response('Unknown coding agent or model.', { status: 400 });
  }
  const prompt = (messages.at(-1)?.parts ?? [])
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join('\n');

  try {
    const agent = agentFor(harness, model as string);
    const session = await sessionFor(id, agent);
    const result = await agent.stream({ session, prompt, abortSignal: request.signal });
    return result.toUIMessageStreamResponse({ onError: getHarnessErrorMessage });
  } catch (error) {
    // Plain text: `useChat` shows the body of a failed response as the error message.
    return new Response(getHarnessErrorMessage(error), { status: 500 });
  }
}
