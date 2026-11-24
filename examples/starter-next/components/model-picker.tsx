'use client';

import { CheckIcon, ChevronsUpDownIcon } from 'lucide-react';
import { useMemo, useState } from 'react';

import type { HarnessId, OpenRouterModel } from '@/lib/harnesses';

import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorName,
  ModelSelectorTrigger,
} from '@/components/ai-elements/model-selector';
import { Button } from '@/components/ui/button';
import { HARNESSES, modelGroupsOf, modelNameOf } from '@/lib/harnesses';

/**
 * The model of a conversation, picked among those its harness offers: the suggested ones, then,
 * for a harness that goes through OpenRouter, every model of OpenRouter it can run, searchable.
 */
export function ModelPicker({
  disabled,
  harness,
  model,
  onChange,
  openRouterModels,
}: {
  disabled: boolean;
  harness: HarnessId;
  model: string;
  onChange: (model: string) => void;
  openRouterModels: readonly OpenRouterModel[];
}) {
  const [open, setOpen] = useState(false);
  const groups = useMemo(
    () => modelGroupsOf(harness, openRouterModels),
    [harness, openRouterModels],
  );

  return (
    <ModelSelector onOpenChange={setOpen} open={open}>
      <ModelSelectorTrigger asChild>
        <Button aria-label="Model" disabled={disabled} size="sm" variant="outline">
          <span className="max-w-48 truncate">{modelNameOf(harness, model, openRouterModels)}</span>
          <ChevronsUpDownIcon className="text-muted-foreground" />
        </Button>
      </ModelSelectorTrigger>
      <ModelSelectorContent title={`The model of ${HARNESSES[harness].label}`}>
        <ModelSelectorInput placeholder="Search a model…" />
        <ModelSelectorList>
          <ModelSelectorEmpty>No model of this name.</ModelSelectorEmpty>
          {groups.map(({ label: heading, models }) => (
            <ModelSelectorGroup heading={heading} key={heading}>
              {models.map((option) => (
                <ModelSelectorItem
                  key={option.id}
                  onSelect={() => {
                    onChange(option.id);
                    setOpen(false);
                  }}
                  // Searched by its name and its id: `kimi`, `moonshotai/`…
                  value={`${option.label} ${option.id}`}
                >
                  <ModelSelectorName>{option.label}</ModelSelectorName>
                  <span className="truncate text-xs text-muted-foreground">{option.id}</span>
                  {option.id === model && <CheckIcon className="ml-auto size-4" />}
                </ModelSelectorItem>
              ))}
            </ModelSelectorGroup>
          ))}
        </ModelSelectorList>
      </ModelSelectorContent>
    </ModelSelector>
  );
}
