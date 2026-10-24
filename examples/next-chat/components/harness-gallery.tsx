'use client';

import { BotIcon, CheckIcon, KeyRoundIcon } from 'lucide-react';

import type { HarnessAvailability, HarnessId } from '@/lib/harnesses';

import { HARNESS_IDS, HARNESSES } from '@/lib/harnesses';
import { cn } from '@/lib/utils';

function Tag({ children }: { children: string }) {
  return (
    <span className="rounded-sm bg-muted px-1 text-[10px] tracking-wide text-muted-foreground uppercase">
      {children}
    </span>
  );
}

/** What sets a harness apart in the example, in a few words. */
function traitsOf(harness: HarnessId): string[] {
  const { asksFirst, runsIn } = HARNESSES[harness];
  return [
    runsIn === 'sandbox' ? 'Runs in the sandbox' : 'Runs on the server, tools in the sandbox',
    ...(asksFirst ? ['Approval policy'] : []),
  ];
}

/**
 * The coding agents of the example, one card each, to pick the one a new conversation runs. A
 * harness whose credential the server does not have is greyed out, with the variables to set.
 */
export function HarnessGallery({
  availability,
  harness,
  onPick,
}: {
  availability: HarnessAvailability;
  harness: HarnessId;
  onPick: (harness: HarnessId) => void;
}) {
  return (
    <section aria-label="Coding agents" className="w-full max-w-3xl text-left">
      <h4 className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <BotIcon className="size-3.5" /> Coding agents
      </h4>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {HARNESS_IDS.map((id) => {
          const { credentials, description, label, route } = HARNESSES[id];
          const available = availability[id];
          const on = id === harness;
          return (
            <button
              aria-pressed={on}
              className={cn(
                'flex items-start gap-3 rounded-lg border p-3 text-left transition-colors',
                on && 'border-primary/40 bg-accent/40',
                available ? 'hover:bg-accent' : 'cursor-not-allowed opacity-50',
              )}
              disabled={!available}
              key={id}
              onClick={() => onPick(id)}
              type="button"
            >
              <span
                className={cn(
                  'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border',
                  on && 'border-primary bg-primary text-primary-foreground',
                )}
              >
                {on && <CheckIcon className="size-3" />}
              </span>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="flex items-center gap-2 text-sm font-medium">
                  {label}
                  <Tag>{route}</Tag>
                </span>
                <span className="text-xs text-muted-foreground">{description}</span>
                <span className="text-xs text-muted-foreground/80">{traitsOf(id).join(' · ')}</span>
                {!available && (
                  <span className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
                    <KeyRoundIcon className="size-3 shrink-0" /> Needs {credentials}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
