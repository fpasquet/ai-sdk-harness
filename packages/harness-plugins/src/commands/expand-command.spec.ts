import { describe, expect, it } from 'vitest';

import type { Plugin } from '../definitions/plugin.js';

import { expandCommand, listSlashCommands } from './expand-command.js';

const review: Plugin = {
  name: 'review',
  description: '',
  commands: [
    { name: 'review', description: 'Review a PR', prompt: 'Review pull request #$1, focus on $2.' },
    { name: 'plan', description: 'Plan', argumentHint: '<goal>', prompt: 'Plan this: $ARGUMENTS' },
    { name: 'explain', description: 'Explain', prompt: 'Explain the code.' },
  ],
  skills: [
    { name: 'review-style', description: 'How to review.', content: '' },
    { name: 'explain', description: 'A skill named like a command.', content: '' },
  ],
};
const other: Plugin = {
  name: 'other',
  description: '',
  commands: [{ name: 'plan', description: 'Other plan', prompt: 'Other: $ARGUMENTS' }],
};

describe('expandCommand', () => {
  it('replaces the positional arguments of a command, a quoted one kept whole', () => {
    expect(expandCommand('/review 42 "the migration"', [review])).toEqual({
      kind: 'command',
      plugin: 'review',
      name: 'review',
      arguments: '42 "the migration"',
      prompt: 'Review pull request #42, focus on the migration.',
    });
  });

  it('replaces $ARGUMENTS, and leaves missing positional ones empty', () => {
    expect(expandCommand('  /plan add a cache\n', [review])?.prompt).toBe('Plan this: add a cache');
    expect(expandCommand('/review', [review])?.prompt).toBe('Review pull request #, focus on .');
  });

  it('appends the arguments to a prompt that uses none', () => {
    expect(expandCommand('/review:explain src/a.ts', [review])?.prompt).toBe(
      'Explain the code.\n\nARGUMENTS: src/a.ts',
    );
    expect(expandCommand('/review:explain', [review])?.prompt).toBe('Explain the code.');
  });

  it('asks the agent to use a skill, with what follows it', () => {
    expect(expandCommand('/review-style the auth module', [review])).toEqual({
      kind: 'skill',
      plugin: 'review',
      name: 'review-style',
      arguments: 'the auth module',
      prompt: 'Use the "review-style" skill.\n\nthe auth module',
    });
    expect(expandCommand('/review-style', [review])?.prompt).toBe('Use the "review-style" skill.');
  });

  it('leaves a message that calls nothing alone', () => {
    expect(expandCommand('review 42', [review])).toBeUndefined();
    expect(expandCommand('/unknown 42', [review])).toBeUndefined();
    expect(expandCommand('/not valid!', [review])).toBeUndefined();
  });

  it('namespaces a name two share, a command winning over a skill', () => {
    expect(expandCommand('/plan x', [review, other])).toBeUndefined();
    expect(expandCommand('/other:plan x', [review, other])?.prompt).toBe('Other: x');
    expect(expandCommand('/explain', [review])).toBeUndefined();
    expect(expandCommand('/review:explain', [review])?.kind).toBe('command');
  });
});

describe('listSlashCommands', () => {
  it('lists the commands, then the skills, with the name a user calls them by', () => {
    expect(listSlashCommands([review, other, { name: 'none', description: '' }])).toEqual([
      {
        kind: 'command',
        plugin: 'review',
        name: 'review',
        invocation: '/review',
        description: 'Review a PR',
      },
      {
        kind: 'command',
        plugin: 'review',
        name: 'plan',
        invocation: '/review:plan',
        description: 'Plan',
        argumentHint: '<goal>',
      },
      {
        kind: 'command',
        plugin: 'review',
        name: 'explain',
        invocation: '/review:explain',
        description: 'Explain',
      },
      {
        kind: 'command',
        plugin: 'other',
        name: 'plan',
        invocation: '/other:plan',
        description: 'Other plan',
      },
      {
        kind: 'skill',
        plugin: 'review',
        name: 'review-style',
        invocation: '/review-style',
        description: 'How to review.',
      },
      {
        kind: 'skill',
        plugin: 'review',
        name: 'explain',
        invocation: '/review:explain',
        description: 'A skill named like a command.',
      },
    ]);
  });
});
