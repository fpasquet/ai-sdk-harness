import type { LanguageModel } from 'ai';

import { generateText, jsonSchema, Output } from 'ai';

import type { EvalCheck, EvalExpectations, EvalRun, JudgeCriterion } from '../definitions/eval.js';

import { excerpt, listOf, messageOf } from '../utils/text.js';

/** The score a criterion must reach when it does not say. */
export const DEFAULT_JUDGE_THRESHOLD = 0.7;

interface Verdict {
  score: number;
  reason: string;
}

const VERDICT = jsonSchema<Verdict>({
  type: 'object',
  properties: {
    score: {
      type: 'number',
      minimum: 0,
      maximum: 1,
      description: '1 when the answer fully meets the criteria, 0 when it does not at all.',
    },
    reason: { type: 'string', description: 'Why, in one or two sentences.' },
  },
  required: ['score', 'reason'],
  additionalProperties: false,
});

const SYSTEM =
  'You grade the answer of an AI agent against criteria. You only judge, you never answer the ' +
  'request yourself. Read the request, the tools the agent called and its answer, then score how ' +
  'well the answer meets the criteria, from 0 to 1.';

/** The criteria of the `judge` expectations. */
export const criteriaOf = (expect: EvalExpectations): JudgeCriterion[] =>
  listOf(expect.judge).map((criterion) =>
    typeof criterion === 'string' ? { criteria: criterion } : criterion,
  );

/** What the judge reads of a trial: the conversation's text, and the tools by name. */
function promptOf(run: Pick<EvalRun, 'turns'>, criteria: string): string {
  const turns = run.turns.map(
    (turn, index) =>
      `<turn index="${index}">\n<request>\n${turn.prompt}\n</request>\n` +
      `<tools>${turn.toolCalls.map(({ name, status }) => `${name} (${status})`).join(', ')}</tools>\n` +
      `<answer>\n${turn.text}\n</answer>\n</turn>`,
  );
  return `${turns.join('\n')}\n\n<criteria>\n${criteria}\n</criteria>`;
}

/** The model that judges, and the signal that stops it with the trial. */
export interface Judge {
  model: LanguageModel;
  abortSignal: AbortSignal;
}

/** Grades one criterion; a judge that fails fails the check, it is never skipped. */
async function grade(
  { model, abortSignal }: Judge,
  run: Pick<EvalRun, 'turns'>,
  { criteria, threshold = DEFAULT_JUDGE_THRESHOLD }: JudgeCriterion,
): Promise<EvalCheck> {
  const name = `judge(${excerpt(criteria, 60)})`;
  try {
    const { output } = await generateText({
      model,
      system: SYSTEM,
      prompt: promptOf(run, criteria),
      output: Output.object({ schema: VERDICT }),
      abortSignal,
    });
    const score = Math.min(1, Math.max(0, output.score));
    return {
      name,
      passed: score >= threshold,
      score,
      message: `${score.toFixed(2)} (threshold ${threshold}): ${output.reason}`,
    };
  } catch (error) {
    return { name, passed: false, score: 0, message: `The judge failed: ${messageOf(error)}` };
  }
}

/** The checks of the `judge` expectations, graded together. */
export async function judgeChecks(
  expect: EvalExpectations,
  run: Pick<EvalRun, 'turns'>,
  judge: Judge,
): Promise<EvalCheck[]> {
  return Promise.all(criteriaOf(expect).map((criterion) => grade(judge, run, criterion)));
}
