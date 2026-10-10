'use client';

import type { SessionStatus, SessionSummary } from 'ai-sdk-harness-sessions';

import { EllipsisIcon, PauseIcon, SquarePenIcon, Trash2Icon } from 'lucide-react';

import type { Conversation } from '@/lib/conversations';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { STATUS_LABELS } from '@/lib/conversations';
import { HARNESSES } from '@/lib/harnesses';
import { cn } from '@/lib/utils';

/** The colour of each status's dot: green when it can take a message, amber when it needs you. */
const STATUS_DOTS: Record<SessionStatus, string> = {
  preparing: 'bg-sky-500 animate-pulse',
  idle: 'bg-success',
  busy: 'bg-sky-500 animate-pulse',
  'awaiting-input': 'bg-warning',
  suspended: 'bg-muted-foreground/40',
  closed: 'bg-muted-foreground/20',
  failed: 'bg-destructive',
  interrupted: 'bg-destructive',
};

export function StatusDot({ status }: { status: SessionStatus }) {
  return <span aria-hidden className={cn('size-2 shrink-0 rounded-full', STATUS_DOTS[status])} />;
}

/** "2 min ago", from an ISO 8601 date. */
function ago(iso: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86_400)} d ago`;
}

/**
 * The conversations, each a session of `ai-sdk-harness-sessions`, with its status as the server
 * sends it: working, ready, waiting for an approval, suspended…
 */
export function SessionList({
  active,
  now,
  onDelete,
  onNew,
  onSelect,
  onSuspend,
  sessions,
}: {
  active: string;
  now: number;
  onDelete: (id: string) => void;
  onNew: () => void;
  onSelect: (id: string) => void;
  onSuspend: (id: string) => void;
  sessions: SessionSummary<Conversation>[];
}) {
  return (
    <aside className="hidden w-72 shrink-0 flex-col border-r bg-muted/30 md:flex">
      <div className="flex items-center justify-between gap-2 p-3">
        <h2 className="text-sm font-semibold">Conversations</h2>
        <Button onClick={onNew} size="sm" variant="ghost">
          <SquarePenIcon /> New chat
        </Button>
      </div>
      <nav className="flex-1 space-y-1 overflow-y-auto px-2 pb-3">
        {sessions.length === 0 && (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground">
            Each conversation is a session: it keeps running while you open another one.
          </p>
        )}
        {sessions.map((session) => (
          <SessionItem
            active={session.id === active}
            key={session.id}
            now={now}
            onDelete={() => onDelete(session.id)}
            onSelect={() => onSelect(session.id)}
            onSuspend={() => onSuspend(session.id)}
            session={session}
          />
        ))}
      </nav>
    </aside>
  );
}

function SessionItem({
  active,
  now,
  onDelete,
  onSelect,
  onSuspend,
  session,
}: {
  active: boolean;
  now: number;
  onDelete: () => void;
  onSelect: () => void;
  onSuspend: () => void;
  session: SessionSummary<Conversation>;
}) {
  const { metadata, status } = session;
  const harness = HARNESSES[metadata.harness];
  const model = harness.models.find(({ id }) => id === metadata.model)?.label ?? metadata.model;
  const suspendable = status === 'idle' || status === 'awaiting-input';

  return (
    <div className={cn('group relative rounded-md p-2 hover:bg-accent', active && 'bg-accent')}>
      <button className="block w-full text-left" onClick={onSelect} type="button">
        <span className="block truncate pr-6 text-sm font-medium">{metadata.title}</span>
        <span className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
          <StatusDot status={status} />
          <span
            className={cn(
              'whitespace-nowrap',
              status === 'awaiting-input' && 'font-medium text-foreground',
            )}
          >
            {STATUS_LABELS[status]}
          </span>
          <span aria-hidden>·</span>
          <span className="truncate">
            {harness.label}, {model}
          </span>
        </span>
        <span className="mt-0.5 block text-[11px] text-muted-foreground/80">
          {session.turns} {session.turns === 1 ? 'turn' : 'turns'} · {ago(session.updatedAt, now)}
        </span>
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            aria-label="Conversation actions"
            className="absolute top-1.5 right-1.5 size-7 opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100"
            size="icon"
            variant="ghost"
          >
            <EllipsisIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem disabled={!suspendable} onSelect={onSuspend}>
            <PauseIcon /> Suspend now
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onDelete} variant="destructive">
            <Trash2Icon /> Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
