import type { EvalCaseReport, EvalReport } from '../definitions/eval.js';
import type { EvalComparison } from './compare-reports.js';

const score = (value: number): string => value.toFixed(2);

const signed = (value: number): string => `${value >= 0 ? '+' : ''}${value.toFixed(2)}`;

const duration = (ms: number): string => {
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${seconds % 60}s`;
};

/** A case's line, then a line for each failure of its trials. */
function caseLines(report: EvalCaseReport): string[] {
  const passed = report.trials.filter((trial) => trial.passed).length;
  const lines = [
    `${report.passed ? '✓' : '✗'} ${report.name}  ${passed}/${report.trials.length}  score ${score(report.score)}`,
  ];
  for (const [index, trial] of report.trials.entries()) {
    const prefix = report.trials.length === 1 ? '    ' : `    trial ${index + 1}: `;
    if (trial.error !== undefined) lines.push(`${prefix}error: ${trial.error}`);
    for (const check of trial.checks) {
      if (!check.passed) lines.push(`${prefix}✗ ${check.name}: ${check.message ?? 'failed'}`);
    }
  }
  return lines;
}

/**
 * A report as text, for a terminal or a test's failure message: a line per case, a line per failed
 * check under it, and the totals.
 */
export function formatReport(report: EvalReport): string {
  const passed = report.cases.filter((entry) => entry.passed).length;
  return [
    ...report.cases.flatMap(caseLines),
    '',
    `${passed}/${report.cases.length} cases passed · score ${score(report.score)} · ${duration(report.durationMs)}`,
  ].join('\n');
}

/** A comparison as text: a line per case, its score before and after, and the totals. */
export function formatComparison(comparison: EvalComparison): string {
  const lines = comparison.cases.map(({ name, baseline, candidate, scoreDelta }) => {
    const mark = (results: typeof baseline): string =>
      results === undefined ? '—' : `${results.passed ? '✓' : '✗'} ${score(results.score)}`;
    const delta = scoreDelta === undefined ? '' : `  (${signed(scoreDelta)})`;
    return `${name}  ${mark(baseline)} → ${mark(candidate)}${delta}`;
  });
  return [
    ...lines,
    '',
    `score ${signed(comparison.scoreDelta)} · ${comparison.improved.length} improved · ${comparison.regressed.length} regressed`,
  ].join('\n');
}
