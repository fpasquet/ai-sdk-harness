import type { EvalCaseReport, EvalReport } from '../definitions/eval.js';

/** A case's results in one report. */
export type EvalCaseResults = Pick<EvalCaseReport, 'passed' | 'passRate' | 'score'>;

/** A case of two reports, side by side. */
export interface EvalCaseComparison {
  name: string;
  /** Its results in the baseline; `undefined` when the baseline has no such case. */
  baseline: EvalCaseResults | undefined;
  /** Its results in the candidate; `undefined` when the candidate has no such case. */
  candidate: EvalCaseResults | undefined;
  /** The candidate's score less the baseline's, when both have the case. */
  scoreDelta: number | undefined;
  /** The candidate's pass rate less the baseline's, when both have the case. */
  passRateDelta: number | undefined;
}

/** What `compareReports()` finds. */
export interface EvalComparison {
  /** The candidate's score less the baseline's, over the cases both have. */
  scoreDelta: number;
  /** The cases of either report, in the baseline's order, then the candidate's new ones. */
  cases: EvalCaseComparison[];
  /** The cases the candidate passes and the baseline does not. */
  improved: string[];
  /** The cases the baseline passes and the candidate does not. */
  regressed: string[];
}

const resultsOf = ({ passed, passRate, score }: EvalCaseReport): EvalCaseResults => ({
  passed,
  passRate,
  score,
});

/**
 * Two reports of the same cases side by side: an agent without a plugin and with it, with one
 * model and another, on Claude Code and on Codex… Whatever changed, what it changed case by case.
 */
export function compareReports(baseline: EvalReport, candidate: EvalReport): EvalComparison {
  const names = [...new Set([...baseline.cases, ...candidate.cases].map(({ name }) => name))];
  const pairs = names.map((name) => ({
    name,
    before: baseline.cases.find((entry) => entry.name === name),
    after: candidate.cases.find((entry) => entry.name === name),
  }));
  const shared = pairs.flatMap(({ name, before, after }) =>
    before === undefined || after === undefined ? [] : [{ name, before, after }],
  );
  const deltas = new Map(
    shared.map(({ name, before, after }) => [
      name,
      { scoreDelta: after.score - before.score, passRateDelta: after.passRate - before.passRate },
    ]),
  );
  return {
    scoreDelta:
      shared.length === 0
        ? 0
        : shared.reduce((sum, { before, after }) => sum + after.score - before.score, 0) /
          shared.length,
    cases: pairs.map(({ name, before, after }) => ({
      name,
      baseline: before && resultsOf(before),
      candidate: after && resultsOf(after),
      scoreDelta: deltas.get(name)?.scoreDelta,
      passRateDelta: deltas.get(name)?.passRateDelta,
    })),
    improved: shared
      .filter(({ before, after }) => after.passed && !before.passed)
      .map(({ name }) => name),
    regressed: shared
      .filter(({ before, after }) => before.passed && !after.passed)
      .map(({ name }) => name),
  };
}
