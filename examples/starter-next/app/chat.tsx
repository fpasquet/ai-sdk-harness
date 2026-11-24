'use client';

import type { DynamicToolUIPart, ToolUIPart, UIMessage } from 'ai';

import { useChat } from '@ai-sdk/react';
import { getToolName, isToolUIPart, lastAssistantMessageIsCompleteWithApprovalResponses } from 'ai';
import { describeToolCall } from 'ai-sdk-harness-approval';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { Streamdown } from 'streamdown';

const SUGGESTION = 'Run the tests and fix what fails. Or type /review once the agent changed code.';

type Answer = (approvalId: string, approved: boolean) => void;

/**
 * A tool the agent ran in the sandbox. One that asked for approval shows what the policy decided,
 * and why, or waits for your answer.
 */
function ToolCall({ answer, part }: { answer: Answer; part: DynamicToolUIPart | ToolUIPart }) {
  const { title, detail } = describeToolCall({ toolName: getToolName(part), input: part.input });
  const approval = part.approval;
  return (
    <details
      className="rounded-lg border border-neutral-500/30 text-sm"
      open={part.state === 'approval-requested'}
    >
      <summary className="cursor-pointer px-3 py-2">
        {title} <span className="font-mono text-neutral-500">{detail?.split('\n')[0]}</span>
        {approval?.approved === true && <span className="ml-2 text-green-600">allowed</span>}
        {approval?.approved === false && (
          <span className="ml-2 text-red-600">
            refused{approval.reason ? `: ${approval.reason}` : ''}
          </span>
        )}
      </summary>
      {part.state === 'approval-requested' && approval && (
        <div className="flex gap-2 border-t border-neutral-500/30 p-3">
          <button
            className="rounded-lg bg-green-700 px-3 py-1 text-white"
            onClick={() => answer(approval.id, true)}
          >
            Approve
          </button>
          <button
            className="rounded-lg bg-red-700 px-3 py-1 text-white"
            onClick={() => answer(approval.id, false)}
          >
            Deny
          </button>
        </div>
      )}
      <pre className="overflow-x-auto border-t border-neutral-500/30 p-3 text-xs">
        {JSON.stringify({ input: part.input, output: part.output ?? part.errorText }, null, 2)}
      </pre>
    </details>
  );
}

/** What the agent changed in its checkout of the repository, as a patch. */
function Changes({ id, version }: { id: string; version: number }) {
  const [patch, setPatch] = useState<string>();
  useEffect(() => {
    void fetch(`/api/sessions/${id}/changes`).then(async (response) =>
      setPatch(response.ok ? ((await response.json()) as { patch: string }).patch : undefined),
    );
  }, [id, version]);
  if (!patch) return null;
  return (
    <details className="rounded-lg border border-neutral-500/30 text-sm">
      <summary className="cursor-pointer px-3 py-2">Changes of the agent, as a patch</summary>
      <pre className="max-h-96 overflow-auto border-t border-neutral-500/30 p-3 text-xs">
        {patch}
      </pre>
    </details>
  );
}

export function Chat({
  id,
  initialMessages,
  onTurnEnd,
}: {
  id: string;
  initialMessages: UIMessage[];
  onTurnEnd: () => void;
}) {
  // Whether you answered an approval since the last request: the policy answers some within the
  // turn, and those alone must not send the conversation again.
  const answered = useRef(false);
  const [turns, setTurns] = useState(0);
  const { addToolApprovalResponse, messages, sendMessage, status, stop, error } = useChat({
    id,
    messages: initialMessages,
    // Once you answered every approval, the paused turn goes on.
    sendAutomaticallyWhen: ({ messages: sent }) => {
      if (!answered.current) return false;
      const complete = lastAssistantMessageIsCompleteWithApprovalResponses({ messages: sent });
      if (complete) answered.current = false;
      return complete;
    },
    onFinish: () => {
      setTurns((count) => count + 1);
      onTurnEnd();
    },
  });
  const [input, setInput] = useState('');
  const end = useRef<HTMLDivElement>(null);
  const busy = status === 'submitted' || status === 'streaming';

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [messages]);

  const answer: Answer = (approvalId, approved) => {
    answered.current = true;
    void addToolApprovalResponse({ id: approvalId, approved });
  };
  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (input.trim() === '' || busy) return;
    void sendMessage({ text: input });
    setInput('');
    onTurnEnd();
  };

  return (
    <main className="mx-auto flex h-dvh w-full max-w-3xl flex-col gap-4 p-4">
      <div className="flex flex-1 flex-col gap-4 overflow-y-auto">
        {messages.length === 0 && (
          <p className="m-auto max-w-md text-center text-neutral-500">
            Claude Code, in a Docker Sandbox closed to all but what it needs, under an approval
            policy, with a plugin. The first message builds its template: a minute or two.
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
            {message.parts.map((part, index) =>
              part.type === 'text' ? (
                <Streamdown key={index}>{part.text}</Streamdown>
              ) : isToolUIPart(part) ? (
                <ToolCall answer={answer} key={index} part={part} />
              ) : null,
            )}
          </div>
        ))}
        {status === 'submitted' && <p className="text-neutral-500">The agent is starting…</p>}
        {error && <p className="text-red-600">{error.message}</p>}
        <Changes id={id} version={turns} />
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
