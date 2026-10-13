import type { EvalCheck, EvalExpectations, EvalRun } from '../definitions/eval.js';

import { contains, excerpt, listOf } from '../utils/text.js';
import { isTool } from '../utils/tool-names.js';

type Observed = Pick<EvalRun, 'skills' | 'text' | 'toolCalls'>;

/** The checks of one kind of expectation. */
type Checks = (expect: EvalExpectations, run: Observed) => EvalCheck[];

const check = (name: string, passed: boolean, message: string): EvalCheck => ({
  name,
  passed,
  score: passed ? 1 : 0,
  ...(!passed && { message }),
});

const answerOf = (run: Observed): string => excerpt(run.text) || 'an empty answer';

const toolsOf = (run: Observed): string =>
  run.toolCalls.length === 0
    ? 'no tool'
    : [...new Set(run.toolCalls.map(({ name }) => name))].join(', ');

const includes: Checks = (expect, run) =>
  listOf(expect.includes).map((pattern) =>
    check(`includes(${String(pattern)})`, contains(run.text, pattern), `got ${answerOf(run)}`),
  );

const excludes: Checks = (expect, run) =>
  listOf(expect.excludes).map((pattern) =>
    check(`excludes(${String(pattern)})`, !contains(run.text, pattern), `got ${answerOf(run)}`),
  );

const calledTools: Checks = (expect, run) =>
  (expect.calledTools ?? []).map((tool) => {
    const calls = run.toolCalls.filter(({ name }) => isTool(name, tool));
    const ends = [...new Set(calls.map(({ status }) => status))].join(' or ');
    return check(
      `calledTools(${tool})`,
      calls.some(({ status }) => status === 'completed'),
      calls.length === 0 ? `called ${toolsOf(run)}` : `every call ended ${ends}`,
    );
  });

const notCalledTools: Checks = (expect, run) =>
  (expect.notCalledTools ?? []).map((tool) => {
    const count = run.toolCalls.filter(({ name }) => isTool(name, tool)).length;
    return check(`notCalledTools(${tool})`, count === 0, `called ${count} time(s)`);
  });

const loadedSkills: Checks = (expect, run) =>
  (expect.loadedSkills ?? []).map((skill) =>
    check(
      `loadedSkills(${skill})`,
      run.skills.includes(skill),
      run.skills.length === 0 ? 'loaded no skill' : `loaded ${run.skills.join(', ')}`,
    ),
  );

const maxToolCalls: Checks = ({ maxToolCalls: max }, run) =>
  max === undefined
    ? []
    : [
        check(
          `maxToolCalls(${max})`,
          run.toolCalls.length <= max,
          `made ${run.toolCalls.length} calls: ${toolsOf(run)}`,
        ),
      ];

const noToolErrors: Checks = (expect, run) => {
  if (expect.noToolErrors !== true) return [];
  const failed = run.toolCalls.filter(({ status }) => status === 'failed');
  const errors = failed.map(({ name, error }) => `${name}: ${excerpt(error ?? '', 80)}`);
  return [check('noToolErrors', failed.length === 0, errors.join('; '))];
};

/** Every kind of deterministic expectation, in the order their checks are reported. */
const CHECKS: readonly Checks[] = [
  includes,
  excludes,
  calledTools,
  notCalledTools,
  loadedSkills,
  maxToolCalls,
  noToolErrors,
];

/**
 * The deterministic checks of the expectations, in their order: everything but the judge, which
 * `judgeChecks()` runs.
 */
export const expectationChecks = (expect: EvalExpectations, run: Observed): EvalCheck[] =>
  CHECKS.flatMap((checks) => checks(expect, run));
