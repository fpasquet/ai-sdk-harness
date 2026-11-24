'use client';

import type { UIMessage } from 'ai';

import { useChat } from '@ai-sdk/react';
import { getToolName, isToolUIPart } from 'ai';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { Streamdown } from 'streamdown';

const SUGGESTION = 'Write a script that prints the first ten primes, then run it.';

/** One part of a message: the agent's text as Markdown, or a tool it ran in the sandbox. */
function Part({ part }: { part: UIMessage['parts'][number] }) {
  if (part.type === 'text') return <Streamdown>{part.text}</Streamdown>;
  if (!isToolUIPart(part)) return null;
  return (
    <details className="rounded-lg border border-neutral-500/30 text-sm">
      <summary className="cursor-pointer px-3 py-2 font-mono">
        {getToolName(part)} <span className="text-neutral-500">{part.state}</span>
      </summary>
      <pre className="overflow-x-auto border-t border-neutral-500/30 p-3 text-xs">
        {JSON.stringify({ input: part.input, output: part.output ?? part.errorText }, null, 2)}
      </pre>
    </details>
  );
}

export default function Page() {
  const { messages, sendMessage, status, stop, error } = useChat();
  const [input, setInput] = useState('');
  const end = useRef<HTMLDivElement>(null);
  const busy = status === 'submitted' || status === 'streaming';

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [messages]);

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (input.trim() === '' || busy) return;
    void sendMessage({ text: input });
    setInput('');
  };

  return (
    <main className="mx-auto flex h-dvh max-w-3xl flex-col gap-4 p-4">
      <div className="flex flex-1 flex-col gap-4 overflow-y-auto">
        {messages.length === 0 && (
          <p className="m-auto text-center text-neutral-500">
            Claude Code, in a local Docker Sandbox. The first message builds its template: a minute
            or two.
          </p>
        )}
        {messages.map((message) => (
          <div
            className={
              message.role === 'user'
                ? 'self-end rounded-xl bg-neutral-500/15 px-4 py-2'
                : 'flex flex-col gap-2'
            }
            key={message.id}
          >
            {message.parts.map((part, index) => (
              <Part key={index} part={part} />
            ))}
          </div>
        ))}
        {status === 'submitted' && <p className="text-neutral-500">The agent is starting…</p>}
        {error && <p className="text-red-600">{error.message}</p>}
        <div ref={end} />
      </div>

      <form className="flex gap-2" onSubmit={submit}>
        <textarea
          className="flex-1 resize-none rounded-xl border border-neutral-500/30 bg-transparent p-3"
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) submit(event);
          }}
          placeholder={SUGGESTION}
          rows={3}
          value={input}
        />
        <button
          className="self-end rounded-xl bg-neutral-900 px-4 py-2 text-white dark:bg-neutral-100 dark:text-neutral-900"
          onClick={busy ? () => void stop() : undefined}
          type={busy ? 'button' : 'submit'}
        >
          {busy ? 'Stop' : 'Send'}
        </button>
      </form>
    </main>
  );
}
