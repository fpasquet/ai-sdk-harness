'use client';

import type { AgentTask } from 'ai-sdk-harness-sessions/tasks';

import { CheckCircle2Icon, ChevronDownIcon, CircleDotIcon, CircleIcon } from 'lucide-react';

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';

/**
 * The task list a harness agent keeps while it works — Claude Code's `TodoWrite`, `TaskCreate` and
 * `TaskUpdate` —, as `tasksOf(messages)` reads it: how many are done, the one in progress in what
 * the agent is doing, the done ones struck through. Hidden while the agent kept none.
 *
 * From the ai-sdk-harness registry: https://ai-sdk-harness.pages.dev/docs/ui-components
 */
export function AgentTasks({
  className,
  defaultOpen = true,
  tasks,
}: {
  className?: string;
  /** Whether the list shows open at first; its header folds it. */
  defaultOpen?: boolean;
  tasks: AgentTask[];
}) {
  if (tasks.length === 0) return null;
  const done = tasks.filter(({ status }) => status === 'completed').length;
  return (
    <Collapsible className={cn('text-sm', className)} defaultOpen={defaultOpen}>
      <CollapsibleTrigger className="group flex w-full items-center gap-2 text-left">
        <span className="font-medium">Tasks</span>
        <span className="text-muted-foreground">
          {done} of {tasks.length} done
        </span>
        <ChevronDownIcon className="ml-auto size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ol aria-label="The agent's tasks" className="mt-2 space-y-1">
          {tasks.map((task) => (
            <AgentTaskItem key={task.id} task={task} />
          ))}
        </ol>
      </CollapsibleContent>
    </Collapsible>
  );
}

const STATUS_LABELS: Record<AgentTask['status'], string> = {
  completed: 'Done',
  'in-progress': 'In progress',
  pending: 'To do',
};

const STATUS_ICONS: Record<AgentTask['status'], typeof CircleIcon> = {
  completed: CheckCircle2Icon,
  'in-progress': CircleDotIcon,
  pending: CircleIcon,
};

function AgentTaskItem({ task }: { task: AgentTask }) {
  const { activeForm, description, status, subject } = task;
  const Icon = STATUS_ICONS[status];
  return (
    <li className="flex items-start gap-2" title={description}>
      <Icon
        aria-hidden
        className={cn(
          'mt-0.5 size-4 shrink-0',
          status === 'in-progress' ? 'text-primary' : 'text-muted-foreground',
        )}
      />
      <span className="sr-only">{STATUS_LABELS[status]}: </span>
      <span
        className={cn(
          status === 'completed' && 'text-muted-foreground line-through',
          status === 'in-progress' && 'font-medium',
        )}
      >
        {status === 'in-progress' ? (activeForm ?? subject) : subject}
      </span>
    </li>
  );
}
