import { describe, expect, it } from 'vitest';

import type { AgentQuestions } from './questions.js';

import { answersOf, describeAnswers, isComplete } from './questions.js';

const questions: AgentQuestions = {
  allowPartialAnswers: false,
  questions: [
    {
      id: 'language',
      question: 'Which language?',
      options: [
        { id: 'ts', label: 'TypeScript' },
        { id: 'go', label: 'Go' },
      ],
    },
    { id: 'name', question: 'What name?', allowFreeForm: true },
  ],
};

describe('answersOf', () => {
  it('gives the answers to every question', () => {
    expect(
      answersOf(questions, { language: { optionIds: ['ts'] }, name: { freeform: ' demo ' } }),
    ).toEqual({
      action: 'answered',
      answers: { language: { optionIds: ['ts'] }, name: { optionIds: [], freeform: 'demo' } },
    });
  });

  it('declines when nothing was answered, and answers in part when allowed', () => {
    expect(answersOf(questions, { name: { freeform: '  ' } })).toEqual({ action: 'declined' });
    expect(
      answersOf({ ...questions, allowPartialAnswers: true }, { language: { optionIds: ['go'] } }),
    ).toEqual({
      action: 'partially-answered',
      answers: { language: { optionIds: ['go'] } },
    });
  });
});

describe('isComplete', () => {
  it('needs every answer, unless partial answers do', () => {
    expect(isComplete(questions, { language: { optionIds: ['ts'] } })).toBe(false);
    expect(
      isComplete(questions, { language: { optionIds: ['ts'] }, name: { freeform: 'x' } }),
    ).toBe(true);
    expect(
      isComplete({ ...questions, allowPartialAnswers: true }, { name: { freeform: 'x' } }),
    ).toBe(true);
    expect(isComplete({ ...questions, allowPartialAnswers: true }, {})).toBe(false);
  });
});

describe('describeAnswers', () => {
  it('says the answers in words', () => {
    expect(
      describeAnswers(questions, {
        action: 'partially-answered',
        answers: { language: { optionIds: ['go', 'rust'], freeform: 'or Zig' } },
      }),
    ).toBe(
      [
        'My answers to your questions:',
        '- Which language? — Go; rust; or Zig',
        '- What name? — no answer',
      ].join('\n'),
    );
    expect(describeAnswers(questions, { action: 'declined' })).toBe(
      'I would rather not answer your questions.',
    );
    expect(describeAnswers(questions, { action: 'cancelled' })).toBe('I cancelled your questions.');
  });
});
