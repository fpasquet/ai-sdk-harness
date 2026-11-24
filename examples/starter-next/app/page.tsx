'use client';

import type { UIMessage } from 'ai';

import { useChat } from '@ai-sdk/react';
import { getToolName, isToolUIPart } from 'ai';
import { ArrowUpIcon, SquareIcon } from 'lucide-react';
import { type FormEvent, type KeyboardEvent, useState } from 'react';

import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation';
import { Message, MessageContent, MessageResponse } from '@/components/ai-elements/message';
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from '@/components/ai-elements/tool';
import { Button } from '@/components/ui/button';

const SUGGESTION = 'Write a script that prints the first ten primes, then run it.';

/** One part of a message: the agent's text as Markdown, or a tool it ran in the sandbox. */
function Part({ part }: { part: UIMessage['parts'][number] }) {
  if (part.type === 'text') return <MessageResponse>{part.text}</MessageResponse>;
  if (!isToolUIPart(part)) return null;
  return (
    <Tool>
      <ToolHeader state={part.state} title={getToolName(part)} type={part.type} />
      <ToolContent>
        <ToolInput input={part.input} />
        <ToolOutput errorText={part.errorText} output={part.output} />
      </ToolContent>
    </Tool>
  );
}

export default function Page() {
  const { messages, sendMessage, status, stop, error } = useChat();
  const [input, setInput] = useState('');
  const busy = status === 'submitted' || status === 'streaming';

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const text = input.trim();
    if (text === '' || busy) return;
    void sendMessage({ text });
    setInput('');
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) submit(event);
  };

  return (
    <main className="mx-auto flex h-dvh max-w-3xl flex-col p-4">
      <Conversation className="flex-1">
        <ConversationContent>
          {messages.length === 0 ? (
            <ConversationEmptyState
              description="Claude Code, in a local Docker Sandbox. The first message builds its template: a minute or two."
              title="Ask the agent to write and run some code"
            />
          ) : (
            messages.map((message) => (
              <Message from={message.role} key={message.id}>
                <MessageContent>
                  {message.parts.map((part, index) => (
                    <Part key={index} part={part} />
                  ))}
                </MessageContent>
              </Message>
            ))
          )}
          {status === 'submitted' && (
            <p className="text-muted-foreground text-sm">The agent is starting…</p>
          )}
          {error && <p className="text-destructive text-sm">{error.message}</p>}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <form className="relative mt-4" onSubmit={submit}>
        <textarea
          className="bg-background focus-visible:ring-ring/50 min-h-24 w-full resize-none rounded-xl border p-3 pr-14 text-sm outline-none focus-visible:ring-2"
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={SUGGESTION}
          value={input}
        />
        {busy ? (
          <Button
            aria-label="Stop"
            className="absolute right-3 bottom-4"
            onClick={() => void stop()}
            size="icon"
            type="button"
          >
            <SquareIcon />
          </Button>
        ) : (
          <Button aria-label="Send" className="absolute right-3 bottom-4" size="icon" type="submit">
            <ArrowUpIcon />
          </Button>
        )}
      </form>
    </main>
  );
}
