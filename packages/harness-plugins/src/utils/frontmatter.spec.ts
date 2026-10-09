import { describe, expect, it } from 'vitest';

import { listOf, parseFrontmatter, stringifyFrontmatter } from './frontmatter.js';

describe('parseFrontmatter', () => {
  it('reads scalars, quoted or not, and both kinds of lists', () => {
    const { data, body } = parseFrontmatter(
      [
        '---',
        'name: reviewer',
        'description: "Reviews: the diff"',
        "hint: 'it''s fine'",
        'tools: [Read, "Grep"]',
        'skills:',
        '  - one',
        '  - "two"',
        'empty-list:',
        'model: haiku',
        'not a key',
        '---',
        '',
        'The body.',
      ].join('\n'),
    );
    expect(data).toEqual({
      name: 'reviewer',
      description: 'Reviews: the diff',
      hint: "it's fine",
      tools: ['Read', 'Grep'],
      skills: ['one', 'two'],
      'empty-list': [],
      model: 'haiku',
    });
    expect(body).toBe('The body.');
  });

  it('gives a document without frontmatter empty data', () => {
    expect(parseFrontmatter('\nJust text.\n')).toEqual({ data: {}, body: 'Just text.' });
  });

  it('keeps a badly quoted value as written, without its quotes', () => {
    expect(parseFrontmatter('---\nkey: "a\\x"\n---\n').data).toEqual({ key: 'a\\x' });
  });
});

describe('stringifyFrontmatter', () => {
  it('writes what parseFrontmatter reads back, leaving undefined values out', () => {
    const text = stringifyFrontmatter(
      {
        name: 'a',
        description: 'It: "quotes"\nand lines',
        tools: ['Read', 'Bash'],
        model: undefined,
      },
      '\nInstructions.\n',
    );
    expect(text).toBe(
      '---\nname: "a"\ndescription: "It: \\"quotes\\"\\nand lines"\ntools: ["Read", "Bash"]\n---\n\nInstructions.\n',
    );
    expect(parseFrontmatter(text)).toEqual({
      data: { name: 'a', description: 'It: "quotes"\nand lines', tools: ['Read', 'Bash'] },
      body: 'Instructions.',
    });
  });
});

describe('listOf', () => {
  it('splits a comma-separated value and keeps a list', () => {
    expect(listOf('Read, Grep ,')).toEqual(['Read', 'Grep']);
    expect(listOf(['Read'])).toEqual(['Read']);
    expect(listOf(undefined)).toBeUndefined();
  });
});
