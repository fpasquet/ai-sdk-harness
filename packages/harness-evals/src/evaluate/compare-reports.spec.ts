import { describe, expect, it } from 'vitest';

import type { EvalCaseReport, EvalReport } from '../index.js';

import { compareReports, formatComparison, formatReport } from '../index.js';

const caseReport = (
  name: string,
  score: number,
  overrides: Partial<EvalCaseReport> = {},
): EvalCaseReport => ({
  name,
  tags: [],
  passed: score === 1,
  passRate: score === 1 ? 1 : 0,
  score,
  trials: [],
  ...overrides,
});

const report = (...cases: EvalCaseReport[]): EvalReport => ({
  passed: cases.every(({ passed }) => passed),
  score: cases.reduce((sum, { score }) => sum + score, 0) / cases.length,
  cases,
  durationMs: 83_000,
});

describe('compareReports', () => {
  it('puts the cases of two reports side by side', () => {
    const without = report(caseReport('docs', 0.5), caseReport('tour', 1), caseReport('old', 1));
    const withPlugin = report(caseReport('docs', 1), caseReport('tour', 0.5), caseReport('new', 1));

    const comparison = compareReports(without, withPlugin);

    expect(comparison.cases.map(({ name, scoreDelta }) => [name, scoreDelta])).toEqual([
      ['docs', 0.5],
      ['tour', -0.5],
      ['old', undefined],
      ['new', undefined],
    ]);
    expect(comparison.scoreDelta).toBe(0);
    expect(comparison.improved).toEqual(['docs']);
    expect(comparison.regressed).toEqual(['tour']);
    expect(formatComparison(comparison)).toBe(
      [
        'docs  ✗ 0.50 → ✓ 1.00  (+0.50)',
        'tour  ✓ 1.00 → ✗ 0.50  (-0.50)',
        'old  ✓ 1.00 → —',
        'new  — → ✓ 1.00',
        '',
        'score +0.00 · 1 improved · 1 regressed',
      ].join('\n'),
    );
  });
});

describe('formatReport', () => {
  it('shows a line per case, and a line per failed check under it', () => {
    const run = (passed: boolean, extra: object = {}) => ({
      text: '',
      turns: [],
      toolCalls: [],
      skills: [],
      messages: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      durationMs: 0,
      checks: passed
        ? [{ name: 'includes(yes)', passed: true, score: 1 }]
        : [{ name: 'includes(yes)', passed: false, score: 0, message: 'got no' }],
      passed,
      score: passed ? 1 : 0,
      ...extra,
    });

    const text = formatReport(
      report(
        caseReport('one', 1, { trials: [run(true)] }),
        caseReport('two', 1 / 3, {
          passed: false,
          trials: [run(true), run(false), run(false, { error: 'Bridge lost', checks: [] })],
        }),
      ),
    );

    expect(text).toBe(
      [
        '✓ one  1/1  score 1.00',
        '✗ two  1/3  score 0.33',
        '    trial 2: ✗ includes(yes): got no',
        '    trial 3: error: Bridge lost',
        '',
        '1/2 cases passed · score 0.67 · 1m23s',
      ].join('\n'),
    );
  });
});
