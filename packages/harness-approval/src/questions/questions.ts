import type { HarnessV1QuestionsToolInput, HarnessV1QuestionsToolOutput } from '@ai-sdk/harness';

/**
 * The name the harnesses give, in the stream, to the agent's questions to the user: Claude Code's
 * `AskUserQuestion`, for instance. The turn waits for their answers, given as the tool's output.
 */
export const QUESTIONS_TOOL_NAME = 'askUserQuestions';

/** The questions the agent asks: the input of `askUserQuestions`. */
export type AgentQuestions = HarnessV1QuestionsToolInput;

/** One question, with its options. */
export type AgentQuestion = AgentQuestions['questions'][number];

/** The answers to the agent's questions: the output of `askUserQuestions`. */
export type AgentAnswers = HarnessV1QuestionsToolOutput;

/** The answers a person picked, question by question, as a form keeps them. */
export type AnswerSelection = Record<string, { optionIds?: readonly string[]; freeform?: string }>;

/**
 * The answers to give the agent: `answered` when every question has one, `partially-answered`
 * when the questions allow it, and `declined` when nothing was answered.
 */
export function answersOf(questions: AgentQuestions, selection: AnswerSelection): AgentAnswers {
  const answers = pickedAnswers(questions, selection);
  const count = Object.keys(answers).length;
  if (count === 0) return { action: 'declined' };
  if (count < questions.questions.length && questions.allowPartialAnswers) {
    return { action: 'partially-answered', answers };
  }
  return { action: 'answered', answers };
}

/** The questions a person answered, with what they picked or wrote. */
function pickedAnswers(
  questions: AgentQuestions,
  selection: AnswerSelection,
): Record<string, { optionIds: string[]; freeform?: string }> {
  const answers: Record<string, { optionIds: string[]; freeform?: string }> = {};
  for (const { id } of questions.questions) {
    const optionIds = [...(selection[id]?.optionIds ?? [])];
    const freeform = selection[id]?.freeform?.trim();
    if (optionIds.length === 0 && !freeform) continue;
    answers[id] = { optionIds, ...(freeform && { freeform }) };
  }
  return answers;
}

/** Whether a person can send `selection`: every question answered, unless partial answers do. */
export function isComplete(questions: AgentQuestions, selection: AnswerSelection): boolean {
  const answered = (id: string) =>
    (selection[id]?.optionIds?.length ?? 0) > 0 || Boolean(selection[id]?.freeform?.trim());
  return questions.allowPartialAnswers
    ? questions.questions.some(({ id }) => answered(id))
    : questions.questions.every(({ id }) => answered(id));
}

/** The answers in words, question by question: for a summary, or for the agent to read. */
export function describeAnswers(questions: AgentQuestions, answers: AgentAnswers): string {
  if (answers.action === 'declined') return 'I would rather not answer your questions.';
  if (answers.action === 'cancelled') return 'I cancelled your questions.';
  const lines = questions.questions.map(({ id, question, options = [] }) => {
    const answer = answers.answers[id];
    const picked = (answer?.optionIds ?? []).map(
      (optionId) => options.find((option) => option.id === optionId)?.label ?? optionId,
    );
    const said = [...picked, ...(answer?.freeform ? [answer.freeform] : [])].join('; ');
    return `- ${question} — ${said || 'no answer'}`;
  });
  return ['My answers to your questions:', ...lines].join('\n');
}
