'use client';

import type { SessionSummary } from 'ai-sdk-harness-sessions';
import type { UIMessage } from 'ai';

import { useCallback, useEffect, useState } from 'react';

import type { Conversation } from '@/lib/sessions';

import { Chat } from './chat';

const newId = () => crypto.randomUUID();

/** The conversations on the left, the one open on the right. */
export default function Page() {
  const [list, setList] = useState<SessionSummary<Conversation>[]>([]);
  const [open, setOpen] = useState<{ id: string; messages: UIMessage[] }>(() => ({
    id: newId(),
    messages: [],
  }));

  const refresh = useCallback(async () => {
    const response = await fetch('/api/sessions');
    if (response.ok) setList(await response.json());
  }, []);

  // The statuses change while the agents work: idle, working, waiting for you, suspended.
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, [refresh]);

  const show = async (id: string) => {
    const response = await fetch(`/api/sessions/${id}`);
    if (response.ok) setOpen({ id, messages: (await response.json()).messages });
  };

  return (
    <div className="flex h-dvh">
      <nav className="flex w-64 shrink-0 flex-col gap-1 border-r border-neutral-500/30 p-3 text-sm">
        <button
          className="mb-2 rounded-lg border border-neutral-500/30 px-3 py-2 text-left"
          onClick={() => setOpen({ id: newId(), messages: [] })}
        >
          New conversation
        </button>
        {list.map((session) => (
          <button
            className={`rounded-lg px-3 py-2 text-left ${session.id === open.id ? 'bg-neutral-500/15' : ''}`}
            key={session.id}
            onClick={() => void show(session.id)}
          >
            <span className="block truncate">{session.metadata.title}</span>
            <span className="text-xs text-neutral-500">{session.status}</span>
          </button>
        ))}
      </nav>
      {/* A new conversation, or another one opened: a chat of its own. */}
      <Chat
        id={open.id}
        initialMessages={open.messages}
        key={open.id}
        onTurnEnd={() => void refresh()}
      />
    </div>
  );
}
