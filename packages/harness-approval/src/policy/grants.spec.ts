import { describe, expect, it } from 'vitest';

import { commandPrefix, describeGrant, suggestGrant, withGrants } from './grants.js';

describe('commandPrefix', () => {
  it('keeps the subcommand of the commands that have one', () => {
    expect(commandPrefix('ls -la')).toBe('ls');
    expect(commandPrefix('node date.js')).toBe('node');
    expect(commandPrefix('git push origin main')).toBe('git push');
    expect(commandPrefix('git -C app status')).toBe('git');
    expect(commandPrefix('npm run test:unit -- --watch')).toBe('npm run test:unit');
    expect(commandPrefix('pnpm exec')).toBe('pnpm exec');
    expect(commandPrefix('pnpm')).toBe('pnpm');
  });
});

describe('suggestGrant', () => {
  it('grants the prefix of each command a call runs', () => {
    expect(suggestGrant({ toolName: 'bash', input: { command: 'cd app && npm test' } })).toEqual({
      grants: [
        { kind: 'command', prefix: 'cd' },
        { kind: 'command', prefix: 'npm test' },
      ],
      label: 'Always allow `cd`, `npm test`',
    });
    expect(
      suggestGrant({ toolName: 'bash', input: { command: 'git status && git status' } }).grants,
    ).toEqual([{ kind: 'command', prefix: 'git status' }]);
  });

  it('grants every file edit for an edit, and the tool for anything else', () => {
    expect(suggestGrant({ toolName: 'Write', input: { file_path: 'a.ts' } })).toEqual({
      grants: [{ kind: 'edit' }],
      label: 'Always allow file edits',
    });
    expect(suggestGrant({ toolName: 'webFetch', input: { url: 'https://x' } })).toEqual({
      grants: [{ kind: 'tool', toolName: 'webFetch' }],
      label: 'Always allow webFetch',
    });
    expect(suggestGrant({ toolName: 'bash', input: {} }).grants).toEqual([
      { kind: 'tool', toolName: 'bash' },
    ]);
  });
});

describe('grants', () => {
  it('says what a grant allows', () => {
    expect(describeGrant({ kind: 'command', prefix: 'ls' })).toBe('`ls` commands');
    expect(describeGrant({ kind: 'edit' })).toBe('file edits');
    expect(describeGrant({ kind: 'edit', path: 'src/**' })).toBe('edits of `src/**`');
    expect(describeGrant({ kind: 'tool', toolName: 'x' })).toBe('the tool x');
  });

  it('adds grants once', () => {
    expect(
      withGrants(
        [{ kind: 'command', prefix: 'ls' }],
        [{ kind: 'command', prefix: 'ls' }, { kind: 'edit' }, { kind: 'edit' }],
      ),
    ).toEqual([{ kind: 'command', prefix: 'ls' }, { kind: 'edit' }]);
    expect(withGrants(undefined, [])).toEqual([]);
  });
});
