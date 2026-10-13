import { describe, expect, it } from 'vitest';

import { isTool, skillsLoadedBy } from './tool-names.js';

describe('isTool', () => {
  it.each([
    ['Bash', 'bash'],
    ['shell', 'bash'],
    ['bash', 'Bash'],
    ['apply_patch', 'edit'],
    ['kernel', 'kernel'],
  ])('takes %s for %s', (called, tool) => {
    expect(isTool(called, tool)).toBe(true);
  });

  it.each([
    ['Read', 'bash'],
    ['kernel', 'Kernel'],
  ])('does not take %s for %s', (called, tool) => {
    expect(isTool(called, tool)).toBe(false);
  });
});

describe('skillsLoadedBy', () => {
  it('reads the skill of Claude Code’s Skill tool', () => {
    expect(skillsLoadedBy('Skill', { skill: 'code-tour' })).toEqual(['code-tour']);
  });

  it('reads the skills whose SKILL.md a call reads', () => {
    expect(
      skillsLoadedBy('shell', {
        command: "sed -n 1,80p '/home/agent/.agents/skills/release-notes/SKILL.md'",
      }),
    ).toEqual(['release-notes']);
    expect(skillsLoadedBy('Read', { file_path: '/home/agent/.claude/skills/a/SKILL.md' })).toEqual([
      'a',
    ]);
  });

  it('finds none elsewhere', () => {
    expect(skillsLoadedBy('Bash', { command: 'ls skills/' })).toEqual([]);
    expect(skillsLoadedBy('Skill', 'code-tour')).toEqual([]);
  });
});
