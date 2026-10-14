import type { HarnessV1NetworkSandboxSession } from '@ai-sdk/harness';
import type { Plugin } from 'ai-sdk-harness-plugins';

import type {
  CheckOutcome,
  EvalCase,
  EvalCaseReport,
  EvalCheck,
  EvalReport,
  EvalRun,
  EvalSandboxes,
  EvaluateSettings,
} from '../definitions/eval.js';
import type { TrialObservation } from '../run/run-trial.js';

import { expectationChecks } from '../checks/expectations.js';
import { judgeChecks } from '../checks/judge.js';
import { InvalidEvalError } from '../errors/invalid-eval-error.js';
import { runTrial } from '../run/run-trial.js';
import { Limiter } from '../utils/limiter.js';
import { listOf, messageOf } from '../utils/text.js';
import { validate } from './validate.js';

/** How long a trial may take when neither the case nor `evaluate()` says. */
export const DEFAULT_TIMEOUT_MS = 5 * 60_000;

const mean = (values: readonly number[], empty: number): number =>
  values.length === 0 ? empty : values.reduce((sum, value) => sum + value, 0) / values.length;

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

/** The sandboxes of the trials: those given, or one sandbox, lent to one trial at a time. */
export function sandboxesOf(
  sandbox: EvalSandboxes | HarnessV1NetworkSandboxSession,
): EvalSandboxes {
  if ('acquire' in sandbox && typeof sandbox.acquire === 'function') return sandbox;
  const sandboxSession = sandbox as HarnessV1NetworkSandboxSession;
  return {
    capacity: 1,
    acquire: () => Promise.resolve({ sandboxSession, close: () => Promise.resolve() }),
  };
}

/** How many trials run at once: `concurrency`, within what the sandboxes hold. */
export function concurrencyOf(
  settings: Pick<EvaluateSettings, 'concurrency'>,
  sandboxes: EvalSandboxes,
): number {
  const capacity = sandboxes.capacity ?? Number.POSITIVE_INFINITY;
  const concurrency = settings.concurrency ?? Math.min(capacity, Number.MAX_SAFE_INTEGER);
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new InvalidEvalError(
      sandboxes.capacity === undefined
        ? '`concurrency` must be a whole number ≥ 1: the sandboxes set no limit of their own.'
        : '`concurrency` must be a whole number ≥ 1.',
    );
  }
  if (concurrency > capacity) {
    throw new InvalidEvalError(
      `\`concurrency\` is ${concurrency}, but the sandboxes hold ${capacity} session(s) at once` +
        (capacity === 1
          ? ': one sandbox runs one trial at a time. Give `sharedSandbox()` or `sandboxPerSession()` of ai-sdk-harness-sessions.'
          : '.'),
    );
  }
  return concurrency;
}

/** What one trial of a case needs. */
interface Trial {
  evalCase: EvalCase;
  prompts: readonly string[];
  sandboxes: EvalSandboxes;
}

/** Runs one trial of a case, and checks it. */
async function runOnce(
  settings: EvaluateSettings,
  { evalCase, prompts, sandboxes }: Trial,
): Promise<EvalRun> {
  const timeout = AbortSignal.timeout(
    evalCase.timeoutMs ?? settings.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  const abortSignal =
    settings.abortSignal === undefined ? timeout : AbortSignal.any([timeout, settings.abortSignal]);
  const observed = await runTrial({
    agent: settings.agent,
    sandboxes,
    prompts,
    approvals: evalCase.approvals ?? settings.approvals ?? 'approve',
    abortSignal,
  });
  return judged(settings, evalCase, { observed, abortSignal });
}

/** Why a case does not run on the agent's runtime, if it does not. */
const skipReasonOf = (evalCase: EvalCase, harness: string | undefined): string | undefined =>
  harness === undefined || evalCase.harnesses === undefined || evalCase.harnesses.includes(harness)
    ? undefined
    : `made for ${evalCase.harnesses.join(', ')}, not ${harness}`;

/** The report of a case, from its trials. */
function caseReport(
  settings: EvaluateSettings,
  evalCase: EvalCase,
  runs: EvalRun[],
): EvalCaseReport {
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

/** A case made for other runtimes: reported, never run. */
const skippedReport = (evalCase: EvalCase, skipped: string): EvalCaseReport => ({
  name: evalCase.name,
  tags: evalCase.tags ?? [],
  skipped,
  passed: true,
  passRate: 1,
  score: 1,
  trials: [],
});

/**
 * `evaluate()` on `limiter`, which a catalog's runs share: its trials wait for a place there, and
 * their time starts once they have one.
 */
export async function evaluateOn(
  settings: EvaluateSettings,
  { sandboxes, limiter }: { sandboxes: EvalSandboxes; limiter: Limiter },
): Promise<EvalReport> {
  const started = Date.now();
  const cases: EvalCaseReport[] = [];
  const tasks: Promise<void>[] = [];
  for (const [index, evalCase] of settings.cases.entries()) {
    const skipped = skipReasonOf(evalCase, settings.harness);
    if (skipped !== undefined) {
      cases[index] = skippedReport(evalCase, skipped);
      settings.onCaseEnd?.(cases[index]);
      continue;
    }
    const prompts = await promptsOf(evalCase, settings.plugins);
    const trials = evalCase.trials ?? settings.trials ?? 1;
    const runs: EvalRun[] = [];
    let left = trials;
    for (let trial = 0; trial < trials; trial += 1) {
      const task = async (): Promise<void> => {
        settings.abortSignal?.throwIfAborted();
        runs[trial] = await runOnce(settings, { evalCase, prompts, sandboxes });
        left -= 1;
        if (left > 0) return;
        cases[index] = caseReport(settings, evalCase, runs);
        settings.onCaseEnd?.(cases[index]);
      };
      // Grouped by agent: in a shared sandbox, two agents would overwrite each other's skills.
      tasks.push(limiter.run(task, settings.agent));
    }
  }
  await Promise.all(tasks);
  const ran = cases.filter(({ skipped }) => skipped === undefined);
  return {
    passed: cases.every(({ passed }) => passed),
    score: mean(
      ran.map(({ score }) => score),
      1,
    ),
    cases,
    durationMs: Date.now() - started,
  };
}

/**
 * Runs each case on the agent — every trial a new session, several at once when the sandboxes
 * allow it — and checks what it answered and did: the report says which cases passed, with a
 * score.
 *
 * @throws {InvalidEvalError} before any case runs, when the cases cannot run as they are.
 */
export async function evaluate(settings: EvaluateSettings): Promise<EvalReport> {
  validate(settings);
  const sandboxes = sandboxesOf(settings.sandbox);
  const limiter = new Limiter(concurrencyOf(settings, sandboxes), sandboxes.shared === true);
  return evaluateOn(settings, { sandboxes, limiter });
}
