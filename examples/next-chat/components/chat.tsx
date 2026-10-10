'use client';

import type { UIMessage } from 'ai';
import type { AgentAnswers } from 'ai-sdk-harness-approval';
import type { CatalogDescription } from 'ai-sdk-harness-plugins';
import type { SessionEvent, SessionSummary } from 'ai-sdk-harness-sessions';

import { useChat } from '@ai-sdk/react';
import {
  lastAssistantMessageIsCompleteWithApprovalResponses,
  lastAssistantMessageIsCompleteWithToolCalls,
} from 'ai';
import { QUESTIONS_TOOL_NAME } from 'ai-sdk-harness-approval';
import { BoxIcon, ShieldQuestionIcon, SquarePenIcon } from 'lucide-react';
import { nanoid } from 'nanoid';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { ToolApprovalResponse } from '@/components/harness/tool-approval';
import type { PartAnswers } from '@/components/message-part';
import type { Conversation } from '@/lib/conversations';

import {
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
  Conversation as ConversationView,
} from '@/components/ai-elements/conversation';
import { Message, MessageContent } from '@/components/ai-elements/message';
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTools,
} from '@/components/ai-elements/prompt-input';
import { Shimmer } from '@/components/ai-elements/shimmer';
import { Suggestion, Suggestions } from '@/components/ai-elements/suggestion';
import {
  everything,
  expandSelection,
  MarketplacePicker,
  SelectionCount,
} from '@/components/marketplace-picker';
import { MessagePart } from '@/components/message-part';
import {
  type PromptCommand,
  PromptEditor,
  type PromptEditorHandle,
} from '@/components/prompt-editor';
import { SessionList, StatusDot } from '@/components/session-list';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { POLICY_SUMMARY } from '@/lib/approval';
import { STATUS_LABELS } from '@/lib/conversations';
import { defaultModel, HARNESS_IDS, HARNESSES, type HarnessId } from '@/lib/harnesses';
import { SANDBOXES, type SandboxId } from '@/lib/sandboxes';
import { cn } from '@/lib/utils';

const SUGGESTIONS = [
  'Write a script that prints the first ten primes, then run it',
  'What is installed in this sandbox?',
  'Create a tiny HTTP server, start it and curl it',
];

/** What a new conversation picks before its first message, and keeps afterwards. */
type Agent = Omit<Conversation, 'title'>;

/** A conversation open in this tab: a new one has no session on the server yet. */
interface Opened {
  id: string;
  fresh: boolean;
}

/** Applies an event of the server to the list of conversations. */
function applyEvent(
  sessions: SessionSummary<Conversation>[],
  event: SessionEvent<Conversation>,
): SessionSummary<Conversation>[] {
  if (event.type === 'deleted') return sessions.filter(({ id }) => id !== event.sessionId);
  return [event.session, ...sessions.filter(({ id }) => id !== event.session.id)].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  );
}

/** The current time, every 30 seconds: what "2 min ago" is counted from. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/**
 * The conversations, each a session on the server, and the one open. Every conversation opened in
 * this tab stays mounted: a turn keeps streaming while another conversation is shown. The list
 * follows the sessions as the server changes them, through server-sent events.
 */
export function ChatApp({
  initialSessions,
  marketplace,
  sandbox,
}: {
  initialSessions: SessionSummary<Conversation>[];
  marketplace: CatalogDescription;
  sandbox: SandboxId;
}) {
  const [sessions, setSessions] = useState(initialSessions);
  const [first] = useState(nanoid);
  const [opened, setOpened] = useState<Opened[]>([{ id: first, fresh: true }]);
  const [active, setActive] = useState(first);
  const [draft, setDraft] = useState<Agent>({
    harness: 'claude-code',
    model: defaultModel('claude-code'),
    selection: everything(marketplace),
    askFirst: false,
  });
  const now = useNow();
  const byId = useMemo(() => new Map(sessions.map((session) => [session.id, session])), [sessions]);

  useEffect(() => {
    const source = new EventSource('/api/sessions/events');
    source.onmessage = ({ data }: MessageEvent<string>) =>
      setSessions((current) => applyEvent(current, JSON.parse(data) as SessionEvent<Conversation>));
    return () => source.close();
  }, []);

  const select = useCallback((id: string) => {
    setOpened((current) =>
      current.some((entry) => entry.id === id) ? current : [...current, { id, fresh: false }],
    );
    setActive(id);
  }, []);

  const newChat = useCallback(() => {
    const id = nanoid();
    setOpened((current) => [...current, { id, fresh: true }]);
    setActive(id);
  }, []);

  const remove = useCallback(
    async (id: string) => {
      await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
      setOpened((current) => current.filter((entry) => entry.id !== id));
      if (id === active) newChat();
    },
    [active, newChat],
  );

  return (
    <div className="flex h-dvh">
      <SessionList
        active={active}
        now={now}
        onDelete={(id) => void remove(id)}
        onNew={newChat}
        onSelect={select}
        onSuspend={(id) => void fetch(`/api/sessions/${id}/suspend`, { method: 'POST' })}
        sessions={sessions}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        {opened.map(({ id, fresh }) => (
          <ChatPanel
            draft={draft}
            fresh={fresh}
            hidden={id !== active}
            id={id}
            key={id}
            marketplace={marketplace}
            onDraftChange={setDraft}
            onNewChat={newChat}
            sandbox={sandbox}
            session={byId.get(id)}
          />
        ))}
      </div>
    </div>
  );
}

/** A conversation: its messages loaded first when it was not started in this tab. */
function ChatPanel(props: Omit<ChatProps, 'initialMessages'> & { fresh: boolean }) {
  const { fresh, hidden, id } = props;
  const [initialMessages, setInitialMessages] = useState<UIMessage[] | undefined>(
    fresh ? [] : undefined,
  );
  useEffect(() => {
    if (initialMessages !== undefined) return;
    void fetch(`/api/sessions/${id}`)
      .then(async (response) =>
        response.ok ? ((await response.json()) as { messages: UIMessage[] }).messages : [],
      )
      .then(setInitialMessages);
  }, [id, initialMessages]);

  if (initialMessages === undefined) {
    return hidden ? null : <Shimmer className="m-auto text-sm">Loading the conversation…</Shimmer>;
  }
  return <Chat {...props} initialMessages={initialMessages} />;
}

interface ChatProps {
  /** What a new conversation picks: the agent it runs, its model, its plugins. */
  draft: Agent;
  hidden: boolean;
  id: string;
  initialMessages: UIMessage[];
  marketplace: CatalogDescription;
  onDraftChange: (agent: Agent) => void;
  onNewChat: () => void;
  sandbox: SandboxId;
  /** The conversation's session, once the server opened it. */
  session: SessionSummary<Conversation> | undefined;
}

function Chat({
  draft,
  hidden,
  id,
  initialMessages,
  marketplace,
  onDraftChange,
  onNewChat,
  sandbox,
  session,
}: ChatProps) {
  // Whether you answered what the agent waits for since the last request: the approval policy
  // answers some approvals within the turn, and those alone must not send the conversation again.
  const answered = useRef(false);
  const { addToolApprovalResponse, addToolOutput, error, messages, sendMessage, status, stop } =
    useChat({
      id,
      messages: initialMessages,
      // Once every approval and question is answered, the paused turn continues.
      sendAutomaticallyWhen: ({ messages: sent }) => {
        if (!answered.current) return false;
        const complete =
          lastAssistantMessageIsCompleteWithApprovalResponses({ messages: sent }) ||
          lastAssistantMessageIsCompleteWithToolCalls({ messages: sent });
        if (complete) answered.current = false;
        return complete;
      },
    });
  const busy = status === 'submitted' || status === 'streaming';
  // Kept for the whole conversation, once its first message was sent.
  const agent: Agent = session?.metadata ?? draft;
  const locked = session !== undefined || messages.length > 0;
  const harness = HARNESSES[agent.harness];
  const where = SANDBOXES[sandbox];
  const answers = useMemo<PartAnswers>(
    () => ({
      onApproval: ({ approvalId, approved, grants, reason }: ToolApprovalResponse) =>
        void (async () => {
          // "Always allow": kept with the conversation before the turn goes on.
          if (grants !== undefined) {
            await fetch(`/api/sessions/${id}/grants`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ grants }),
            });
          }
          answered.current = true;
          await addToolApprovalResponse({ id: approvalId, approved, reason });
        })(),
      onAnswers: (toolCallId: string, output: AgentAnswers) => {
        answered.current = true;
        void addToolOutput({ tool: QUESTIONS_TOOL_NAME, toolCallId, output });
      },
    }),
    [addToolApprovalResponse, addToolOutput, id],
  );
  const send = useCallback(
    (text: string) => {
      if (text.trim() === '' || busy) return;
      void sendMessage({ text }, { body: agent });
    },
    [agent, busy, sendMessage],
  );

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col', hidden && 'hidden')}>
      <ChatHeader
        agent={agent}
        busy={busy}
        locked={locked}
        onDraftChange={onDraftChange}
        onNewChat={onNewChat}
        sandbox={sandbox}
        session={session}
      />
      <ConversationView className="flex-1">
        <ConversationContent className="mx-auto w-full max-w-3xl">
          {messages.length === 0 ? (
            <ConversationEmptyState className="justify-start gap-6 pt-12">
              <BoxIcon className="size-10 text-muted-foreground" />
              <div className="space-y-1">
                <h3 className="text-sm font-medium">{harness.label} is ready</h3>
                <p className="text-sm text-muted-foreground">
                  A HarnessAgent from the AI SDK, {where.description}. Pick an agent, a model and
                  what it takes from the marketplace, then ask it to write and run some code, or
                  type / for a command or a skill. Each conversation is a session of its own: start
                  another one while this one works.
                </p>
              </div>
              <MarketplacePicker
                harness={agent.harness}
                marketplace={marketplace}
                onChange={(selection) => onDraftChange({ ...agent, selection })}
                selection={agent.selection}
              />
            </ConversationEmptyState>
          ) : (
            messages.map((message, index) => (
              <ChatMessage
                answers={answers}
                isStreaming={status === 'streaming' && index === messages.length - 1}
                key={message.id}
                message={message}
              />
            ))
          )}
          <SessionNotes
            busy={busy}
            error={error}
            session={session}
            submitted={status === 'submitted'}
          />
        </ConversationContent>
        <ConversationScrollButton />
      </ConversationView>
      <Composer
        agent={agent}
        empty={messages.length === 0}
        locked={locked}
        marketplace={marketplace}
        onDraftChange={onDraftChange}
        onSend={send}
        onStop={() => void stop()}
        sandbox={sandbox}
        status={status}
        waiting={session?.status === 'awaiting-input'}
      />
    </div>
  );
}

/** The conversation's title and status, and the agent it runs. */
function ChatHeader({
  agent,
  busy,
  locked,
  onDraftChange,
  onNewChat,
  sandbox,
  session,
}: {
  agent: Agent;
  busy: boolean;
  locked: boolean;
  onDraftChange: (agent: Agent) => void;
  onNewChat: () => void;
  sandbox: SandboxId;
  session: SessionSummary<Conversation> | undefined;
}) {
  const where = SANDBOXES[sandbox];
  return (
    <header className="flex items-center justify-between gap-4 border-b px-4 py-3">
      <div className="flex min-w-0 items-center gap-3">
        <BoxIcon className="size-5 shrink-0 text-muted-foreground" />
        <h1 className="truncate font-semibold">
          {session?.metadata.title ?? `Coding agents in a ${where.label}`}
        </h1>
        {session ? (
          <Badge className="gap-1.5" variant="outline">
            <StatusDot status={session.status} /> {STATUS_LABELS[session.status]}
          </Badge>
        ) : (
          <Badge className="hidden sm:inline-flex" variant="secondary">
            {where.packageName}
          </Badge>
        )}
      </div>
      <div className="flex items-center gap-2">
        <AgentPicker
          agent={agent}
          locked={locked}
          onChange={(next) => onDraftChange({ ...agent, ...next })}
        />
        <SelectionCount count={agent.selection.length} />
        <Button className="md:hidden" disabled={busy} onClick={onNewChat} size="sm" variant="ghost">
          <SquarePenIcon /> New chat
        </Button>
      </div>
    </header>
  );
}

/** What the session is doing when the conversation alone does not say it. */
function SessionNotes({
  busy,
  error,
  session,
  submitted,
}: {
  busy: boolean;
  error: Error | undefined;
  session: SessionSummary<Conversation> | undefined;
  submitted: boolean;
}) {
  const suspended = session?.status === 'suspended';
  return (
    <>
      {submitted && (
        <Shimmer className="text-sm">
          {suspended
            ? 'Resuming the session where it was…'
            : 'Opening the session. The very first message also installs Claude Code and Codex in the sandbox.'}
        </Shimmer>
      )}
      {!busy && suspended && (
        <p className="text-xs text-muted-foreground">
          Suspended{session.error ? ` (${session.error})` : ''}: its harness session is stopped and
          its port freed. The next message resumes it where it was.
        </p>
      )}
      {error && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error.message}
        </p>
      )}
    </>
  );
}

/** The prompt, with the suggestions of a new conversation. */
function Composer({
  agent,
  empty,
  locked,
  marketplace,
  onDraftChange,
  onSend,
  onStop,
  sandbox,
  status,
  waiting,
}: {
  agent: Agent;
  empty: boolean;
  locked: boolean;
  marketplace: CatalogDescription;
  onDraftChange: (agent: Agent) => void;
  onSend: (text: string) => void;
  onStop: () => void;
  sandbox: SandboxId;
  status: ReturnType<typeof useChat>['status'];
  /** The session waits for an approval or an answer: no message until it is given. */
  waiting: boolean;
}) {
  const [input, setInput] = useState('');
  const editor = useRef<PromptEditorHandle>(null);
  const busy = status === 'submitted' || status === 'streaming';
  const harness = HARNESSES[agent.harness];
  const commands = useMemo(
    () => slashCommandsOf(marketplace, agent.selection),
    [agent.selection, marketplace],
  );
  const send = (text: string) => {
    onSend(text);
    setInput('');
  };

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-4">
      {empty && (
        <Suggestions className="mb-3">
          {SUGGESTIONS.map((suggestion) => (
            <Suggestion key={suggestion} onClick={send} suggestion={suggestion} />
          ))}
        </Suggestions>
      )}
      {/* The submit button sends what the editor holds; Enter in it does the same. */}
      <PromptInput onSubmit={() => editor.current?.submit()}>
        <PromptInputBody>
          <PromptEditor
            commands={commands}
            disabled={busy || waiting}
            onChange={setInput}
            onSubmit={send}
            placeholder={
              waiting
                ? 'The agent waits for your answer, above.'
                : `Ask ${harness.label} to write and run some code, or type / for a command or a skill…`
            }
            ref={editor}
          />
        </PromptInputBody>
        <PromptInputFooter>
          <PromptInputTools>
            {harness.asksFirst && (
              <AskFirstToggle
                checked={agent.askFirst}
                disabled={locked}
                onChange={(askFirst) => onDraftChange({ ...agent, askFirst })}
              />
            )}
            <span className="hidden px-2 text-xs text-muted-foreground lg:inline">
              {harness.label} runs in {SANDBOXES[sandbox].where}
            </span>
          </PromptInputTools>
          <PromptInputSubmit
            disabled={!busy && input.trim() === ''}
            onClick={(event) => {
              if (!busy) return;
              event.preventDefault();
              onStop();
            }}
            status={status}
          />
        </PromptInputFooter>
      </PromptInput>
    </div>
  );
}

/**
 * Whether the conversation follows the approval policy of the example: what it allows runs, what
 * it denies is refused, and the rest waits, the session "Needs you", until you approve or deny it.
 */
function AskFirstToggle({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <HoverCard openDelay={300}>
      <HoverCardTrigger asChild>
        <Button
          aria-pressed={checked}
          className={cn('text-xs', checked && 'bg-accent text-accent-foreground')}
          disabled={disabled}
          onClick={() => onChange(!checked)}
          size="sm"
          type="button"
          variant="ghost"
        >
          <ShieldQuestionIcon /> {checked ? 'Approval policy' : 'Acts freely'}
        </Button>
      </HoverCardTrigger>
      <HoverCardContent align="start" className="w-80 space-y-2 text-xs">
        <p className="font-medium">With the approval policy</p>
        <p>
          <span className="text-muted-foreground">Runs at once:</span>{' '}
          {POLICY_SUMMARY.allowed.map((rule) => `\`${rule}\``).join(', ')}
        </p>
        <p>
          <span className="text-muted-foreground">Refused:</span> {POLICY_SUMMARY.denied.join(', ')}
        </p>
        <p>
          <span className="text-muted-foreground">Asks you:</span> any other command, and every file
          edit, with &ldquo;Always allow&rdquo; for the rest of the conversation.
        </p>
      </HoverCardContent>
    </HoverCard>
  );
}

/**
 * The commands, then the skills, the conversation picked — with the plugins and the requirements
 * that bring them —, as the prompt offers them after `/`: the names the server's
 * `expandCommand()` expands.
 */
function slashCommandsOf(marketplace: CatalogDescription, selection: string[]): PromptCommand[] {
  const picked = expandSelection(marketplace, selection);
  const items = marketplace.items.filter(({ id }) => picked.has(id));
  return [
    ...items.filter(({ kind }) => kind === 'command'),
    ...items.filter(({ kind }) => kind === 'skill'),
  ].map(({ argumentHint, description, invocation, kind, name }) => ({
    ...(argumentHint !== undefined && { argumentHint }),
    description,
    kind: kind as PromptCommand['kind'],
    name: invocation?.slice(1) ?? name,
  }));
}

function ChatMessage({
  answers,
  isStreaming,
  message,
}: {
  answers: PartAnswers;
  isStreaming: boolean;
  message: UIMessage;
}) {
  return (
    <Message from={message.role}>
      {/* The agent's answers, tools and tables take the whole column; the user's stay a bubble. */}
      <MessageContent className={message.role === 'assistant' ? 'w-full' : undefined}>
        {message.parts.map((part, index) => (
          <MessagePart
            answers={answers}
            isStreaming={isStreaming && index === message.parts.length - 1}
            key={`${message.id}-${index}`}
            part={part}
          />
        ))}
      </MessageContent>
    </Message>
  );
}

/**
 * The harness and its model; locked once the conversation started. Kept out of the prompt's form:
 * resetting it after each message would reset these selects too.
 */
function AgentPicker({
  agent,
  locked,
  onChange,
}: {
  agent: Agent;
  locked: boolean;
  onChange: (agent: Partial<Agent>) => void;
}) {
  const { models } = HARNESSES[agent.harness];
  const modelLabel = models.find(({ id }) => id === agent.model)?.label ?? agent.model;

  return (
    <>
      <Select
        disabled={locked}
        onValueChange={(harness: HarnessId) =>
          onChange({
            harness,
            model: defaultModel(harness),
            askFirst: agent.askFirst && HARNESSES[harness].asksFirst,
          })
        }
        value={agent.harness}
      >
        <SelectTrigger aria-label="Coding agent" size="sm">
          <SelectValue>{HARNESSES[agent.harness].label}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {HARNESS_IDS.map((harnessId) => (
            <SelectItem key={harnessId} value={harnessId}>
              {HARNESSES[harnessId].label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {/* Remounted with each harness, so it never shows a model of the previous one. */}
      <Select
        disabled={locked}
        key={agent.harness}
        onValueChange={(model: string) => onChange({ harness: agent.harness, model })}
        value={agent.model}
      >
        <SelectTrigger aria-label="Model" size="sm">
          <SelectValue>{modelLabel}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {models.map(({ id, label }) => (
            <SelectItem key={id} value={id}>
              {label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </>
  );
}
