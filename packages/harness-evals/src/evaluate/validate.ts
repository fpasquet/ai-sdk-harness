import type { EvalCase, EvaluateSettings } from '../definitions/eval.js';

/** What `validate()` reads of the settings. */
type Validated = Pick<EvaluateSettings, 'cases' | 'judge' | 'minPassRate' | 'trials'>;

import { criteriaOf } from '../checks/judge.js';
import { InvalidEvalError } from '../errors/invalid-eval-error.js';
import { listOf } from '../utils/text.js';

const isCount = (value: unknown): boolean =>
  value === undefined || (Number.isInteger(value) && (value as number) >= 1);

const isRate = (value: unknown): boolean =>
  value === undefined || (typeof value === 'number' && value >= 0 && value <= 1);

const isText = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '';

const isTextList = (value: unknown): boolean =>
  value === undefined || (Array.isArray(value) && value.every(isText));

/** A string, a RegExp, or `{ regex, flags }` that compiles. */
function isPattern(value: unknown): boolean {
  if (typeof value === 'string' || value instanceof RegExp) return true;
  if (typeof value !== 'object' || value === null) return false;
  const { regex, flags, ...rest } = value as Record<string, unknown>;
  if (typeof regex !== 'string' || !['string', 'undefined'].includes(typeof flags)) return false;
  if (Object.keys(rest).length > 0) return false;
  try {
    new RegExp(regex, flags as string | undefined);
    return true;
  } catch {
    return false;
  }
}

const isPatterns = (value: unknown): boolean =>
  value === undefined || (Array.isArray(value) ? value.every(isPattern) : isPattern(value));

/** A criterion: its text, or `{ criteria, threshold }`. */
function isCriterion(value: unknown): boolean {
  if (isText(value)) return true;
  if (typeof value !== 'object' || value === null) return false;
  const { criteria, threshold, ...rest } = value as Record<string, unknown>;
  return isText(criteria) && isRate(threshold) && Object.keys(rest).length === 0;
}

/** What each expectation may hold, and what to say when it does not. */
const EXPECTATIONS: Record<string, [check: (value: unknown) => boolean, shape: string]> = {
  includes: [isPatterns, 'a string, a RegExp or { "regex", "flags" }, or a list of them'],
  excludes: [isPatterns, 'a string, a RegExp or { "regex", "flags" }, or a list of them'],
  calledTools: [isTextList, 'a list of tool names'],
  notCalledTools: [isTextList, 'a list of tool names'],
  loadedSkills: [isTextList, 'a list of skill names'],
  maxToolCalls: [
    (value) => value === undefined || (Number.isInteger(value) && (value as number) >= 0),
    'a whole number',
  ],
  noToolErrors: [(value) => value === undefined || typeof value === 'boolean', 'true or false'],
  judge: [
    (value) =>
      value === undefined || (Array.isArray(value) ? value.every(isCriterion) : isCriterion(value)),
    'a criterion, { "criteria", "threshold" } with a threshold between 0 and 1, or a list of them',
  ],
};

/** Refuses expectations of a kind the package does not know, or of the wrong shape. */
function validateExpectations(expect: unknown, name: string): void {
  if (expect === undefined) return;
  if (typeof expect !== 'object' || expect === null || Array.isArray(expect)) {
    throw new InvalidEvalError('`expect` must be an object.', name);
  }
  for (const [key, value] of Object.entries(expect)) {
    const rule = EXPECTATIONS[key];
    if (rule === undefined) {
      throw new InvalidEvalError(
        `\`expect.${key}\` is no expectation: use ${Object.keys(EXPECTATIONS).join(', ')}.`,
        name,
      );
    }
    if (!rule[0](value)) throw new InvalidEvalError(`\`expect.${key}\` must be ${rule[1]}.`, name);
  }
}

/** Refuses a case that cannot run: it may come from JSON, so nothing about it is taken on trust. */
function validateCase(evalCase: EvalCase, settings: Validated): void {
  const { name } = evalCase;
  if (!isText(name)) throw new InvalidEvalError('Every case needs a name.');
  const prompts: unknown[] = [...listOf<unknown>(evalCase.prompt)];
  if (prompts.length === 0 || !prompts.every(isText)) {
    throw new InvalidEvalError('Every prompt must say something.', name);
  }
  if (!isCount(evalCase.trials)) {
    throw new InvalidEvalError('`trials` must be a whole number ≥ 1.', name);
  }
  if (!isTextList(evalCase.harnesses)) {
    throw new InvalidEvalError('`harnesses` must be a list of harness ids.', name);
  }
  validateExpectations(evalCase.expect, name);
  if (criteriaOf(evalCase.expect ?? {}).length > 0 && settings.judge === undefined) {
    throw new InvalidEvalError(
      'It has `judge` expectations: give `evaluate()` a `judge` model.',
      name,
    );
  }
}

/** Refuses what cannot run, before any case does: nothing is spent on a suite that would fail. */
export function validate(settings: Validated): void {
  if (settings.cases.length === 0) throw new InvalidEvalError('There is no case to run.');
  if (!isCount(settings.trials)) throw new InvalidEvalError('`trials` must be a whole number ≥ 1.');
  if (!isRate(settings.minPassRate)) {
    throw new InvalidEvalError('`minPassRate` must be between 0 and 1.');
  }
  const names = new Set<string>();
  for (const evalCase of settings.cases) {
    validateCase(evalCase, settings);
    if (names.has(evalCase.name)) {
      throw new InvalidEvalError('Another case has the same name.', evalCase.name);
    }
    names.add(evalCase.name);
  }
}
