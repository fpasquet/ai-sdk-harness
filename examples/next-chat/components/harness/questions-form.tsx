'use client';

import type {
  AgentAnswers,
  AgentQuestion,
  AgentQuestions,
  AnswerSelection,
} from 'ai-sdk-harness-approval';

import { answersOf, describeAnswers, isComplete } from 'ai-sdk-harness-approval';
import { CheckIcon, MessageCircleQuestionIcon, SendIcon } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/**
 * The questions a harness agent asks, `askUserQuestions` (Claude Code's `AskUserQuestion`): its
 * options to pick, one or several, and a free answer when it takes one. The turn waits for the
 * answers: give them with `addToolOutput({ tool: 'askUserQuestions', toolCallId, output })`.
 *
 * From the ai-sdk-harness registry: https://ai-sdk-harness.pages.dev/docs/ui-components
 */
export function QuestionsForm({
  className,
  disabled,
  onSubmit,
  questions,
}: {
  className?: string;
  disabled?: boolean;
  onSubmit: (answers: AgentAnswers) => void;
  questions: AgentQuestions;
}) {
  const [selection, setSelection] = useState<AnswerSelection>({});
  const pick = (id: string, change: AnswerSelection[string]) =>
    setSelection((current) => ({ ...current, [id]: { ...current[id], ...change } }));

  return (
    <form
      className={cn('space-y-4 rounded-md border p-4 text-sm', className)}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(answersOf(questions, selection));
      }}
    >
      {questions.questions.map((question) => (
        <Question
          disabled={disabled}
          key={question.id}
          onChange={(change) => pick(question.id, change)}
          question={question}
          selected={selection[question.id]}
        />
      ))}
      <div className="flex justify-end gap-2">
        <Button
          disabled={disabled}
          onClick={() => onSubmit({ action: 'declined' })}
          size="sm"
          type="button"
          variant="ghost"
        >
          Skip
        </Button>
        <Button disabled={disabled || !isComplete(questions, selection)} size="sm" type="submit">
          <SendIcon /> Send answers
        </Button>
      </div>
    </form>
  );
}

function Question({
  disabled,
  onChange,
  question,
  selected,
}: {
  disabled?: boolean;
  onChange: (change: AnswerSelection[string]) => void;
  question: AgentQuestion;
  selected: AnswerSelection[string] | undefined;
}) {
  const { allowFreeForm, header, options = [] } = question;
  return (
    <fieldset className="space-y-2" disabled={disabled}>
      <legend className="flex items-center gap-2 font-medium">
        <MessageCircleQuestionIcon className="size-4 text-muted-foreground" />
        {header && <span className="text-xs text-muted-foreground uppercase">{header}</span>}
        {question.question}
      </legend>
      {options.length > 0 && (
        <Options
          multiple={question.allowMultiple === true}
          onChange={(optionIds) => onChange({ optionIds })}
          options={options}
          picked={selected?.optionIds ?? []}
        />
      )}
      {(allowFreeForm || options.length === 0) && (
        <FreeForm
          onChange={(freeform) => onChange({ freeform })}
          question={question}
          value={selected?.freeform}
        />
      )}
    </fieldset>
  );
}

/** A free answer, in the person's own words; hidden as it is typed when it is a secret. */
function FreeForm({
  onChange,
  question,
  value = '',
}: {
  onChange: (value: string) => void;
  question: AgentQuestion;
  value?: string;
}) {
  return (
    <Input
      onChange={(event) => onChange(event.target.value)}
      placeholder={question.options?.length ? 'Or answer in your own words' : 'Your answer'}
      type={isSecret(question) ? 'password' : 'text'}
      value={value}
    />
  );
}

/** Whether the free answer to a question is a secret: a password, a token… */
const isSecret = ({ allowFreeForm }: AgentQuestion): boolean =>
  typeof allowFreeForm === 'object' && allowFreeForm.secret;

/** The options of a question: one to pick, or several. */
function Options({
  multiple,
  onChange,
  options,
  picked,
}: {
  multiple: boolean;
  onChange: (optionIds: string[]) => void;
  options: NonNullable<AgentQuestion['options']>;
  picked: readonly string[];
}) {
  const toggle = (optionId: string) =>
    onChange(
      picked.includes(optionId)
        ? picked.filter((id) => id !== optionId)
        : multiple
          ? [...picked, optionId]
          : [optionId],
    );
  return (
    <div className="grid gap-2 sm:grid-cols-2" role={multiple ? 'group' : 'radiogroup'}>
      {options.map(({ description, id, label }) => {
        const checked = picked.includes(id);
        return (
          <button
            aria-checked={checked}
            className={cn(
              'flex items-start gap-2 rounded-md border p-2 text-left transition-colors hover:bg-accent',
              checked && 'border-primary bg-accent',
            )}
            key={id}
            onClick={() => toggle(id)}
            role={multiple ? 'checkbox' : 'radio'}
            type="button"
          >
            <CheckIcon className={cn('mt-0.5 size-4 shrink-0', !checked && 'invisible')} />
            <span>
              <span className="block">{label}</span>
              {description && (
                <span className="block text-xs text-muted-foreground">{description}</span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** The answers with those to secret questions hidden: a summary shows them on screen. */
function withoutSecrets(questions: AgentQuestions, answers: AgentAnswers): AgentAnswers {
  if (!('answers' in answers)) return answers;
  const hidden = { ...answers.answers };
  for (const question of questions.questions) {
    const answer = hidden[question.id];
    if (isSecret(question) && answer?.freeform) {
      hidden[question.id] = { ...answer, freeform: '••••••' };
    }
  }
  return { ...answers, answers: hidden };
}

/** The answers once given, in words. */
export function AnsweredQuestions({
  answers,
  className,
  questions,
}: {
  answers: AgentAnswers;
  className?: string;
  questions: AgentQuestions;
}) {
  const text = describeAnswers(questions, withoutSecrets(questions, answers));
  const [first, ...lines] = text.split('\n');
  return (
    <div className={cn('space-y-1 rounded-md border p-3 text-sm text-muted-foreground', className)}>
      {lines.length === 0 ? <p>{first}</p> : lines.map((line) => <p key={line}>{line}</p>)}
    </div>
  );
}
