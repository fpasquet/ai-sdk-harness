'use client';

import type { UIMessage } from 'ai';
import type { CatalogDescription } from 'ai-sdk-harness-plugins';

import { useChat } from '@ai-sdk/react';
import { BoxIcon, SquarePenIcon } from 'lucide-react';
import { useCallback, useMemo, useRef, useState } from 'react';

import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
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
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { defaultModel, HARNESS_IDS, HARNESSES, type HarnessId } from '@/lib/harnesses';
import { SANDBOXES, type SandboxId } from '@/lib/sandboxes';

const SUGGESTIONS = [
  'Write a script that prints the first ten primes, then run it',
  'What is installed in this sandbox?',
  'Create a tiny HTTP server, start it and curl it',
];

interface Agent {
  harness: HarnessId;
  model: string;
  /** The ids of what it picked in the marketplace: plugins, and items on their own. */
  selection: string[];
}

/**
 * The chat, started afresh (with a new conversation id) by "New chat". The coding agent, its model
 * and what it takes from the marketplace are picked before the first message and kept for the whole conversation; the
 * sandbox it runs in is the server's to pick (`EXAMPLE_SANDBOX`).
 */
export function ChatApp({
  marketplace,
  sandbox,
}: {
  marketplace: CatalogDescription;
  sandbox: SandboxId;
}) {
  const [conversation, setConversation] = useState(0);
  const [agent, setAgent] = useState<Agent>({
    harness: 'claude-code',
    model: defaultModel('claude-code'),
    selection: everything(marketplace),
  });

  return (
    <Chat
      agent={agent}
      key={conversation}
      marketplace={marketplace}
      onAgentChange={setAgent}
      onNewChat={() => setConversation((count) => count + 1)}
      sandbox={sandbox}
    />
  );
}

function Chat({
  agent,
  marketplace,
  onAgentChange,
  onNewChat,
  sandbox,
}: {
  agent: Agent;
  marketplace: CatalogDescription;
  onAgentChange: (agent: Agent) => void;
  onNewChat: () => void;
  sandbox: SandboxId;
}) {
  const { messages, sendMessage, status, stop, error } = useChat();
  const [input, setInput] = useState('');
  const busy = status === 'submitted' || status === 'streaming';
  const harness = HARNESSES[agent.harness];
  const where = SANDBOXES[sandbox];
  const editor = useRef<PromptEditorHandle>(null);
  const commands = useMemo(
    () => slashCommandsOf(marketplace, agent.selection),
    [agent.selection, marketplace],
  );

  const send = useCallback(
    (text: string) => {
      if (text.trim() === '' || busy) return;
      void sendMessage({ text }, { body: agent });
      setInput('');
    },
    [agent, busy, sendMessage],
  );

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex items-center justify-between gap-4 border-b px-4 py-3">
        <div className="flex items-center gap-3">
          <BoxIcon className="size-5 text-muted-foreground" />
          <h1 className="font-semibold">Coding agents in a {where.label}</h1>
          <Badge className="hidden sm:inline-flex" variant="secondary">
            {where.packageName}
          </Badge>
        </div>
        <div className="flex items-center gap-2">
          <AgentPicker agent={agent} locked={messages.length > 0} onChange={onAgentChange} />
          <SelectionCount count={agent.selection.length} />
          <Button disabled={busy} onClick={onNewChat} size="sm" variant="ghost">
            <SquarePenIcon /> New chat
          </Button>
        </div>
      </header>

      <Conversation className="flex-1">
        <ConversationContent className="mx-auto w-full max-w-3xl">
          {messages.length === 0 ? (
            <ConversationEmptyState className="justify-start gap-6 pt-12">
              <BoxIcon className="size-10 text-muted-foreground" />
              <div className="space-y-1">
                <h3 className="text-sm font-medium">{harness.label} is ready</h3>
                <p className="text-sm text-muted-foreground">
                  A HarnessAgent from the AI SDK, {where.description}. Pick an agent, a model and
                  what it takes from the marketplace, then ask it to write and run some code, or
                  type / for a command or a skill.
                </p>
              </div>
              <MarketplacePicker
                harness={agent.harness}
                marketplace={marketplace}
                onChange={(selection) => onAgentChange({ ...agent, selection })}
                selection={agent.selection}
              />
            </ConversationEmptyState>
          ) : (
            messages.map((message, index) => (
              <ChatMessage
                isStreaming={status === 'streaming' && index === messages.length - 1}
                key={message.id}
                message={message}
              />
            ))
          )}
          {status === 'submitted' && (
            <Shimmer className="text-sm">
              Waking the sandbox up. The very first message also installs Claude Code and Codex in
              it.
            </Shimmer>
          )}
          {error && (
            <p className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
              {error.message}
            </p>
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <div className="mx-auto w-full max-w-3xl px-4 pb-4">
        {messages.length === 0 && (
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
              disabled={busy}
              onChange={setInput}
              onSubmit={send}
              placeholder={`Ask ${harness.label} to write and run some code, or type / for a command or a skill…`}
              ref={editor}
            />
          </PromptInputBody>
          <PromptInputFooter>
            <PromptInputTools>
              <span className="px-2 text-xs text-muted-foreground">
                {harness.label} runs in {where.where}
              </span>
            </PromptInputTools>
            <PromptInputSubmit
              disabled={!busy && input.trim() === ''}
              onClick={(event) => {
                if (!busy) return;
                event.preventDefault();
                void stop();
              }}
              status={status}
            />
          </PromptInputFooter>
        </PromptInput>
      </div>
    </div>
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

function ChatMessage({ message, isStreaming }: { isStreaming: boolean; message: UIMessage }) {
  return (
    <Message from={message.role}>
      {/* The agent's answers, tools and tables take the whole column; the user's stay a bubble. */}
      <MessageContent className={message.role === 'assistant' ? 'w-full' : undefined}>
        {message.parts.map((part, index) => (
          <MessagePart
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
 * The harness and its model; locked once the conversation started, "New chat" unlocks them. Kept
 * out of the prompt's form: resetting it after each message would reset these selects too.
 */
function AgentPicker({
  agent,
  locked,
  onChange,
}: {
  agent: Agent;
  locked: boolean;
  onChange: (agent: Agent) => void;
}) {
  const { models } = HARNESSES[agent.harness];
  const modelLabel = models.find(({ id }) => id === agent.model)?.label ?? agent.model;

  return (
    <>
      <Select
        disabled={locked}
        onValueChange={(harness: HarnessId) =>
          onChange({ ...agent, harness, model: defaultModel(harness) })
        }
        value={agent.harness}
      >
        <SelectTrigger aria-label="Coding agent" size="sm">
          <SelectValue>{HARNESSES[agent.harness].label}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {HARNESS_IDS.map((id) => (
            <SelectItem key={id} value={id}>
              {HARNESSES[id].label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {/* Remounted with each harness, so it never shows a model of the previous one. */}
      <Select
        disabled={locked}
        key={agent.harness}
        onValueChange={(model: string) => onChange({ ...agent, model })}
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
