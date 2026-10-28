'use client';

import type { SessionSummary } from 'ai-sdk-harness-sessions';
import type { ChangedFile, GitFileMode } from 'ai-sdk-harness-workspace';

import { ChevronDownIcon, GitBranchIcon } from 'lucide-react';
import { useEffect, useState } from 'react';

import type { Conversation } from '@/lib/conversations';

import { CodeBlock } from '@/components/ai-elements/code-block';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';

/** What `GET /api/sessions/<id>/changes` answers. */
interface Changes {
  branch: string;
  base: string;
  files: ChangedFile[];
  patch: string;
}

/** The modes worth a word: a plain file needs none. */
const MODE_LABELS: Partial<Record<GitFileMode, string>> = {
  '100755': 'executable',
  '120000': 'symbolic link',
  '160000': 'submodule',
};

const STATUS_MARKS: Record<ChangedFile['status'], string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  'type-changed': 'T',
};

/**
 * The changes of a conversation, read again each time its session changes while it is live. A
 * suspended conversation keeps what was read last: its checkout cannot be reached.
 */
function useChanges(
  id: string,
  session: SessionSummary<Conversation> | undefined,
): Changes | undefined {
  const [changes, setChanges] = useState<Changes>();
  const live = session?.status === 'idle' || session?.status === 'awaiting-input';
  useEffect(() => {
    if (!live) return;
    const controller = new AbortController();
    fetch(`/api/sessions/${id}/changes`, { signal: controller.signal })
      .then((response) => (response.ok ? (response.json() as Promise<Changes>) : undefined))
      .then((read) => read && setChanges(read))
      .catch(() => undefined);
    return () => controller.abort();
  }, [id, live, session?.updatedAt]);
  return changes;
}

/**
 * What the agent of the conversation changed in its checkout of `EXAMPLE_REPOSITORY`, since the
 * checkout started: read from its workspace each time a turn ends.
 */
export function ChangesPanel({
  id,
  repository,
  session,
}: {
  id: string;
  repository: string;
  session: SessionSummary<Conversation> | undefined;
}) {
  const changes = useChanges(id, session);
  if (session === undefined) return null;
  const files = changes?.files ?? [];
  return (
    <Collapsible className="border-b px-4 py-2 text-sm">
      <CollapsibleTrigger
        className="group flex w-full items-center gap-2 text-left text-muted-foreground disabled:cursor-default"
        disabled={files.length === 0}
      >
        <GitBranchIcon className="size-4 shrink-0" />
        <span className="truncate">
          <span className="font-medium text-foreground">{repository}</span>
          {changes && (
            <>
              {' '}
              on <code className="text-xs">{changes.branch}</code>, from{' '}
              <code className="text-xs">{changes.base.slice(0, 7)}</code>
            </>
          )}
        </span>
        <ChangeCount changes={changes} />
      </CollapsibleTrigger>
      {changes && files.length > 0 && (
        <CollapsibleContent className="mt-2 space-y-2">
          <ul className="space-y-0.5 font-mono text-xs">
            {files.map((file) => (
              <FileRow file={file} key={file.path} />
            ))}
          </ul>
          <CodeBlock className="max-h-96 overflow-auto" code={changes.patch} language="diff" />
        </CollapsibleContent>
      )}
    </Collapsible>
  );
}

/** How many files changed, and how many lines they gained and lost. */
function ChangeCount({ changes }: { changes: Changes | undefined }) {
  if (changes === undefined) {
    return <span className="ml-auto shrink-0">Checked out when the session starts</span>;
  }
  const { files } = changes;
  if (files.length === 0) return <span className="ml-auto shrink-0">No changes</span>;
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  return (
    <>
      <span className="ml-auto shrink-0">
        {files.length} file{files.length === 1 ? '' : 's'} changed{' '}
        <span className="text-success">+{additions}</span>{' '}
        <span className="text-destructive">−{deletions}</span>
      </span>
      <ChevronDownIcon className="size-4 shrink-0 transition-transform group-data-[state=open]:rotate-180" />
    </>
  );
}

function FileRow({ file }: { file: ChangedFile }) {
  return (
    <li className="flex gap-2">
      <span
        className={cn(
          'w-3',
          file.status === 'added' && 'text-success',
          file.status === 'deleted' && 'text-destructive',
        )}
      >
        {STATUS_MARKS[file.status]}
      </span>
      <span className="truncate">{file.path}</span>
      {file.mode !== undefined && MODE_LABELS[file.mode] !== undefined && (
        <span className="shrink-0 text-muted-foreground">{MODE_LABELS[file.mode]}</span>
      )}
      <span className="ml-auto text-muted-foreground">
        {file.binary ? 'binary' : `+${file.additions} −${file.deletions}`}
      </span>
    </li>
  );
}
