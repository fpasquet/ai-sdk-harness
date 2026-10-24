'use client';

import type { CatalogDescription } from 'ai-sdk-harness-plugins';

import { BoxIcon, ChevronRightIcon } from 'lucide-react';
import { useEffect } from 'react';
import { useStickToBottomContext } from 'use-stick-to-bottom';

import type { Conversation } from '@/lib/conversations';
import type { HarnessAvailability, HarnessId, OpenRouterModel } from '@/lib/harnesses';
import type { SandboxId } from '@/lib/sandboxes';

import { HarnessGallery } from '@/components/harness-gallery';
import { MarketplacePicker } from '@/components/marketplace-picker';
import { ModelPicker } from '@/components/model-picker';
import { Button } from '@/components/ui/button';
import { defaultModel, HARNESSES } from '@/lib/harnesses';
import { SANDBOXES } from '@/lib/sandboxes';
import { cn } from '@/lib/utils';

/** What a new conversation picks before its first message, and keeps afterwards. */
export type Agent = Omit<Conversation, 'title'>;

/** Where a new conversation is in its setup: its coding agent first, then its marketplace. */
export type SetupStep = 'agent' | 'marketplace';

/** `agent` running `harness` instead, on its first model; the approval policy kept if it can ask. */
export const withHarness = (agent: Agent, harness: HarnessId): Agent => ({
  ...agent,
  harness,
  model: defaultModel(harness),
  askFirst: agent.askFirst && HARNESSES[harness].asksFirst,
});

function StepButton({
  current,
  disabled = false,
  label,
  number,
  onClick,
}: {
  current: boolean;
  disabled?: boolean;
  label: string;
  number: number;
  onClick: () => void;
}) {
  return (
    <button
      aria-current={current ? 'step' : undefined}
      className={cn(
        'flex items-center gap-2 rounded-full px-2.5 py-1 transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        current ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent',
      )}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      <span
        className={cn(
          'flex size-4 items-center justify-center rounded-full border text-[10px]',
          current && 'border-primary-foreground',
        )}
      >
        {number}
      </span>
      {label}
    </button>
  );
}

/** The coding agent a conversation picked, its model, and the way back to the gallery. */
function PickedAgent({
  agent,
  onChange,
  onChangeAgent,
  openRouterModels,
}: {
  agent: Agent;
  onChange: (agent: Agent) => void;
  onChangeAgent: () => void;
  openRouterModels: OpenRouterModel[];
}) {
  const { description, label, route } = HARNESSES[agent.harness];
  return (
    <section
      aria-label="Coding agent"
      className="flex w-full max-w-3xl flex-wrap items-center gap-3 rounded-lg border p-3 text-left"
    >
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2 text-sm font-medium">
          {label}
          <span className="rounded-sm bg-muted px-1 text-[10px] tracking-wide text-muted-foreground uppercase">
            {route}
          </span>
        </span>
        <span className="text-xs text-muted-foreground">{description}</span>
      </span>
      <ModelPicker
        disabled={false}
        harness={agent.harness}
        model={agent.model}
        onChange={(model) => onChange({ ...agent, model })}
        openRouterModels={openRouterModels}
      />
      <Button onClick={onChangeAgent} size="sm" variant="ghost">
        Change agent
      </Button>
    </section>
  );
}

/**
 * A conversation before its first message, in two steps: the coding agent it runs, picked in the
 * gallery, then what it takes from the marketplace, with the agent's model. The prompt shows at
 * the second step.
 */
export function NewConversation({
  agent,
  availability,
  marketplace,
  onChange,
  onStep,
  openRouterModels,
  sandbox,
  step,
}: {
  agent: Agent;
  availability: HarnessAvailability;
  marketplace: CatalogDescription;
  onChange: (agent: Agent) => void;
  onStep: (step: SetupStep) => void;
  openRouterModels: OpenRouterModel[];
  sandbox: SandboxId;
  step: SetupStep;
}) {
  const { label } = HARNESSES[agent.harness];
  const available = availability[agent.harness];
  // Each step opens on its top. A conversation sticks to its bottom: a card picked at the bottom
  // of the gallery would otherwise land at the bottom of the marketplace.
  const { scrollRef, stopScroll } = useStickToBottomContext();
  useEffect(() => {
    stopScroll();
    scrollRef.current?.scrollTo({ top: 0 });
  }, [scrollRef, step, stopScroll]);
  return (
    <>
      <BoxIcon className="size-10 text-muted-foreground" />
      <div className="space-y-1">
        <h3 className="text-sm font-medium">
          {step === 'agent' ? 'Pick a coding agent' : `${label} is ready`}
        </h3>
        <p className="text-sm text-muted-foreground">
          A HarnessAgent from the AI SDK, {SANDBOXES[sandbox].description}. Pick the coding agent
          first, then what it takes from the marketplace, and ask it to write and run some code, or
          type / for a command or a skill. Each conversation is a session of its own: start another
          one while this one works.
        </p>
      </div>
      <nav aria-label="Setup" className="flex items-center gap-1 text-xs">
        <StepButton
          current={step === 'agent'}
          label="Coding agent"
          number={1}
          onClick={() => onStep('agent')}
        />
        <ChevronRightIcon className="size-3.5 text-muted-foreground" />
        <StepButton
          current={step === 'marketplace'}
          disabled={!available}
          label="Marketplace"
          number={2}
          onClick={() => onStep('marketplace')}
        />
      </nav>
      {step === 'agent' ? (
        <HarnessGallery
          availability={availability}
          harness={agent.harness}
          onPick={(picked) => {
            if (picked !== agent.harness) onChange(withHarness(agent, picked));
            onStep('marketplace');
          }}
        />
      ) : (
        <>
          <PickedAgent
            agent={agent}
            onChange={onChange}
            onChangeAgent={() => onStep('agent')}
            openRouterModels={openRouterModels}
          />
          <MarketplacePicker
            harness={agent.harness}
            marketplace={marketplace}
            onChange={(selection) => onChange({ ...agent, selection })}
            selection={agent.selection}
          />
        </>
      )}
    </>
  );
}
