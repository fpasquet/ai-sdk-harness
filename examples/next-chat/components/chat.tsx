'use client';

import type { UIMessage } from 'ai';

import { useChat } from '@ai-sdk/react';
import { BoxIcon, SquarePenIcon } from 'lucide-react';
import { useState } from 'react';

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
  PromptInputTextarea,
  PromptInputTools,
} from '@/components/ai-elements/prompt-input';
import { Shimmer } from '@/components/ai-elements/shimmer';
import { Suggestion, Suggestions } from '@/components/ai-elements/suggestion';
import { MessagePart } from '@/components/message-part';
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

const SUGGESTIONS = [
  'Write a script that prints the first ten primes, then run it',
  'What is installed in this sandbox?',
  'Create a tiny HTTP server, start it and curl it',
];

interface Agent {
  harness: HarnessId;
  model: string;
}

/**
 * The chat, started afresh (with a new conversation id) by "New chat". The coding agent and its
 * model are picked before the first message and kept for the whole conversation.
 */
export function ChatApp() {
  const [conversation, setConversation] = useState(0);
  const [agent, setAgent] = useState<Agent>({
    harness: 'claude-code',
    model: defaultModel('claude-code'),
  });

  return (
    <Chat
      agent={agent}
      key={conversation}
      onAgentChange={setAgent}
      onNewChat={() => setConversation((count) => count + 1)}
    />
  );
}

function Chat({
  agent,
  onAgentChange,
  onNewChat,
}: {
  agent: Agent;
  onAgentChange: (agent: Agent) => void;
  onNewChat: () => void;
}) {
  const { messages, sendMessage, status, stop, error } = useChat();
  const [input, setInput] = useState('');
  const busy = status === 'submitted' || status === 'streaming';
  const harness = HARNESSES[agent.harness];

  const send = (text: string) => {
    if (text.trim() === '' || busy) return;
    void sendMessage({ text }, { body: agent });
    setInput('');
  };

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex items-center justify-between gap-4 border-b px-4 py-3">
        <div className="flex items-center gap-3">
          <BoxIcon className="size-5 text-muted-foreground" />
          <h1 className="font-semibold">Coding agents in a Docker Sandbox</h1>
          <Badge className="hidden sm:inline-flex" variant="secondary">
            ai-sdk-sandbox-sbx
          </Badge>
        </div>
        <div className="flex items-center gap-2">
          <AgentPicker agent={agent} locked={messages.length > 0} onChange={onAgentChange} />
          <Button disabled={busy} onClick={onNewChat} size="sm" variant="ghost">
            <SquarePenIcon /> New chat
          </Button>
        </div>
      </header>

      <Conversation className="flex-1">
        <ConversationContent className="mx-auto w-full max-w-3xl">
          {messages.length === 0 ? (
            <ConversationEmptyState
              description="A HarnessAgent from the AI SDK, running in a local microVM. Pick an agent and a model, then ask it to write and run some code."
              icon={<BoxIcon className="size-10" />}
              title={`${harness.label} is ready`}
            />
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
        <PromptInput onSubmit={({ text }) => send(text)}>
          <PromptInputBody>
            <PromptInputTextarea
              onChange={(event) => setInput(event.target.value)}
              placeholder={`Ask ${harness.label} to write and run some code…`}
              value={input}
            />
          </PromptInputBody>
          <PromptInputFooter>
            <PromptInputTools>
              <span className="px-2 text-xs text-muted-foreground">
                {harness.label} runs in a Docker Sandbox microVM, not on your machine
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
        onValueChange={(harness: HarnessId) => onChange({ harness, model: defaultModel(harness) })}
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
