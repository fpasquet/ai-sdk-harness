import type { Plugin } from 'ai-sdk-harness-plugins';

import type {
  CheckOutcome,
  EvalCase,
  EvalCaseReport,
  EvalCheck,
  EvalReport,
  EvalRun,
  EvaluateSettings,
} from '../definitions/eval.js';
import type { TrialObservation } from '../run/run-trial.js';

import { expectationChecks } from '../checks/expectations.js';
import { criteriaOf, judgeChecks } from '../checks/judge.js';
import { InvalidEvalError } from '../errors/invalid-eval-error.js';
import { runTrial } from '../run/run-trial.js';
import { listOf, messageOf } from '../utils/text.js';

/** How long a trial may take when neither the case nor `evaluate()` says. */
export const DEFAULT_TIMEOUT_MS = 5 * 60_000;

const mean = (values: readonly number[], empty: number): number =>
  values.length === 0 ? empty : values.reduce((sum, value) => sum + value, 0) / values.length;

const isCount = (value: number | undefined): boolean =>
  value === undefined || (Number.isInteger(value) && value >= 1);

const isRate = (value: number | undefined): boolean =>
  value === undefined || (value >= 0 && value <= 1);

/** Refuses a case that cannot run. */
function validateCase(evalCase: EvalCase, settings: EvaluateSettings): void {
  const { name } = evalCase;
  if (name.trim() === '') throw new InvalidEvalError('Every case needs a name.');
  const prompts = listOf(evalCase.prompt);
  if (prompts.length === 0 || prompts.some((prompt) => prompt.trim() === '')) {
    throw new InvalidEvalError('Every prompt must say something.', name);
  }
  if (!isCount(evalCase.trials)) {
    throw new InvalidEvalError('`trials` must be a whole number ≥ 1.', name);
  }
  const criteria = criteriaOf(evalCase.expect ?? {});
  if (criteria.length > 0 && settings.judge === undefined) {
    throw new InvalidEvalError(
      'It has `judge` expectations: give `evaluate()` a `judge` model.',
      name,
    );
  }
  if (!criteria.every(({ threshold }) => isRate(threshold))) {
    throw new InvalidEvalError('A judge threshold must be between 0 and 1.', name);
  }
}

/** Refuses what cannot run, before any case does: nothing is spent on a suite that would fail. */
function validate(settings: EvaluateSettings): void {
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

/** The prompts of a case, its `/commands` expanded as the application would. */
async function promptsOf(
  evalCase: EvalCase,
  plugins: readonly Plugin[] | undefined,
): Promise<string[]> {
  const prompts = [...listOf(evalCase.prompt)];
  if (plugins === undefined || !prompts.some((prompt) => prompt.trimStart().startsWith('/'))) {
    return prompts;
  }
  const { expandCommand } = await import('ai-sdk-harness-plugins');
  return prompts.map((prompt) => expandCommand(prompt, plugins)?.prompt ?? prompt);
}

/** The check of the case's own `check`; one that throws fails. */
async function ownCheck(evalCase: EvalCase, run: EvalRun): Promise<EvalCheck[]> {
  if (evalCase.check === undefined) return [];
  let outcome: CheckOutcome;
  try {
    const result = await evalCase.check(run);
    outcome = typeof result === 'boolean' ? { passed: result } : result;
  } catch (error) {
    outcome = { passed: false, message: messageOf(error) };
  }
  const { passed, score, message } = outcome;
  return [
    {
      name: 'check',
      passed,
      score: score ?? (passed ? 1 : 0),
      ...(message !== undefined && { message }),
    },
  ];
}

/** A trial with its checks: the expectations, the judge, then the case's own. */
async function judged(
  settings: EvaluateSettings,
  evalCase: EvalCase,
  { observed, abortSignal }: { observed: TrialObservation; abortSignal: AbortSignal },
): Promise<EvalRun> {
  if (observed.error !== undefined) return { ...observed, checks: [], passed: false, score: 0 };
  const expect = evalCase.expect ?? {};
  const checks = expectationChecks(expect, observed);
  if (settings.judge !== undefined) {
    checks.push(...(await judgeChecks(expect, observed, { model: settings.judge, abortSignal })));
  }
  checks.push(
    ...(await ownCheck(evalCase, { ...observed, checks: [...checks], passed: false, score: 0 })),
  );
  return {
    ...observed,
    checks,
    passed: checks.every(({ passed }) => passed),
    score: mean(
      checks.map(({ score }) => score),
      1,
    ),
  };
}

/** Runs one trial of a case, and checks it. */
async function runOnce(
  settings: EvaluateSettings,
  evalCase: EvalCase,
  prompts: readonly string[],
): Promise<EvalRun> {
  const timeout = AbortSignal.timeout(
    evalCase.timeoutMs ?? settings.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  const abortSignal =
    settings.abortSignal === undefined ? timeout : AbortSignal.any([timeout, settings.abortSignal]);
  const observed = await runTrial({
    agent: settings.agent,
    sandbox: settings.sandbox,
    prompts,
    approvals: evalCase.approvals ?? settings.approvals ?? 'approve',
    abortSignal,
  });
  return judged(settings, evalCase, { observed, abortSignal });
}

/** Runs every trial of a case, one after the other. */
async function runCase(settings: EvaluateSettings, evalCase: EvalCase): Promise<EvalCaseReport> {
  const prompts = await promptsOf(evalCase, settings.plugins);
  const runs: EvalRun[] = [];
  for (let trial = 0; trial < (evalCase.trials ?? settings.trials ?? 1); trial += 1) {
    runs.push(await runOnce(settings, evalCase, prompts));
    settings.abortSignal?.throwIfAborted();
  }
  const passRate = runs.filter(({ passed }) => passed).length / runs.length;
  return {
    name: evalCase.name,
    tags: evalCase.tags ?? [],
    passed: passRate >= (settings.minPassRate ?? 1),
    passRate,
    score: mean(
      runs.map(({ score }) => score),
      0,
    ),
    trials: runs,
  };
}

/**
 * Runs each case on the agent — every trial a new session in the sandbox, one after the other —
 * and checks what it answered and did: the report says which cases passed, with a score.
 *
 * @throws {InvalidEvalError} before any case runs, when the cases cannot run as they are.
 */
export async function evaluate(settings: EvaluateSettings): Promise<EvalReport> {
  validate(settings);
  const started = Date.now();
  const cases: EvalCaseReport[] = [];
  for (const evalCase of settings.cases) {
    const report = await runCase(settings, evalCase);
    cases.push(report);
    settings.onCaseEnd?.(report);
  }
  return {
    passed: cases.every(({ passed }) => passed),
    score: mean(
      cases.map(({ score }) => score),
      0,
    ),
    cases,
    durationMs: Date.now() - started,
  };
}
