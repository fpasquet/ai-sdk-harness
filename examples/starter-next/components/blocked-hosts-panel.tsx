'use client';

import type { SessionSummary } from 'ai-sdk-harness-sessions';

import { ChevronDownIcon, ShieldAlertIcon } from 'lucide-react';
import { useEffect, useState } from 'react';

import type { Conversation } from '@/lib/conversations';
import type { SandboxId } from '@/lib/sandboxes';

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';

/** What `GET /api/sandbox/blocked` answers: the dates as JSON strings. */
interface BlockedHosts {
  sandboxId: string;
  blocked: { host: string; port?: number; reason: string; count: number; lastSeen: string }[];
}

/**
 * The hosts the sandbox was refused, read again each time the conversation's session changes: a
 * local Docker Sandbox only reports them.
 */
function useBlockedHosts(
  sandbox: SandboxId,
  session: SessionSummary<Conversation> | undefined,
): BlockedHosts | undefined {
  const [hosts, setHosts] = useState<BlockedHosts>();
  const opened = sandbox === 'sbx' && session !== undefined;
  useEffect(() => {
    if (!opened) return;
    const controller = new AbortController();
    fetch('/api/sandbox/blocked', { signal: controller.signal })
      .then((response) => (response.ok ? (response.json() as Promise<BlockedHosts>) : undefined))
      .then((read) => read && setHosts(read))
      .catch(() => undefined);
    return () => controller.abort();
  }, [opened, session?.updatedAt]);
  return hosts;
}

/**
 * The hosts the Docker Sandboxes proxy refused to the sandbox the conversations share, from
 * `blockedRequests()` of `ai-sdk-sandbox-sbx`, and how to allow one. Hidden while there is none.
 */
export function BlockedHostsPanel({
  sandbox,
  session,
}: {
  sandbox: SandboxId;
  session: SessionSummary<Conversation> | undefined;
}) {
  const hosts = useBlockedHosts(sandbox, session);
  if (hosts === undefined || hosts.blocked.length === 0) return null;
  const { blocked, sandboxId } = hosts;
  return (
    <Collapsible className="border-b px-4 py-2 text-sm">
      <CollapsibleTrigger className="group flex w-full items-center gap-2 text-left text-muted-foreground">
        <ShieldAlertIcon className="size-4 shrink-0 text-warning" />
        <span className="truncate">
          The sandbox&apos;s network policy refused {blocked.length} host
          {blocked.length === 1 ? '' : 's'}
        </span>
        <ChevronDownIcon className="ml-auto size-4 shrink-0 transition-transform group-data-[state=open]:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2 space-y-2">
        <ul className="space-y-0.5 text-xs">
          {blocked.map(({ host, port, reason, count, lastSeen }) => (
            <li className="flex gap-2" key={`${host}:${port ?? ''}`}>
              <code className="truncate">{port === undefined ? host : `${host}:${port}`}</code>
              <span className="truncate text-muted-foreground">{reason}</span>
              <span className="ml-auto shrink-0 text-muted-foreground">
                {count}× · {new Date(lastSeen).toLocaleTimeString()}
              </span>
            </li>
          ))}
        </ul>
        <p className="text-xs text-muted-foreground">
          Allow one for this sandbox alone with{' '}
          <code>sbx policy allow network --sandbox {sandboxId} &lt;host&gt;</code>, then ask the
          agent again.
        </p>
      </CollapsibleContent>
    </Collapsible>
  );
}
