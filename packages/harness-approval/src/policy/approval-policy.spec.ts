import { describe, expect, it } from 'vitest';

import type { ApprovalGrant } from '../definitions/policy.js';

import { defineApprovalPolicy } from './approval-policy.js';

const bash = (command: string) => ({ toolName: 'bash', input: { command } });
const write = (file_path: string) => ({ toolName: 'write', input: { file_path, content: '' } });

const policy = defineApprovalPolicy({
  commands: {
    allow: ['ls', 'cat', 'cd', 'git status', 'git diff', 'pnpm test'],
    ask: ['git commit'],
    deny: [{ match: 'git push', reason: 'The application publishes the changes.' }, 'rm -rf'],
  },
  edits: { allow: ['src/**'], deny: ['.env*'] },
  tools: { deployPreview: 'ask', dropDatabase: { decision: 'deny', reason: 'Never.' } },
});

describe('ApprovalPolicy.evaluate', () => {
  it('allows a command an allow rule matches, and says which', () => {
    expect(policy.evaluate(bash('git status --short'))).toEqual({
      decision: 'allow',
      reason: 'Allowed by the approval policy (`git status`).',
      rule: 'git status',
    });
  });

  it('denies a command a deny rule matches, with its reason or a default one', () => {
    expect(policy.evaluate(bash('git push origin main'))).toEqual({
      decision: 'deny',
      reason: 'The application publishes the changes.',
      rule: 'git push',
    });
    expect(policy.evaluate(bash('rm -rf dist')).reason).toBe(
      'The approval policy does not allow the command `rm -rf dist` (`rm -rf`).',
    );
  });

  it('asks about a command an ask rule, or no rule, matches', () => {
    expect(policy.evaluate(bash('git commit -m wip'))).toEqual({
      decision: 'ask',
      rule: 'git commit',
    });
    expect(policy.evaluate(bash('curl https://example.com'))).toEqual({ decision: 'ask' });
  });

  it('holds each command of a chain to the rules: the least allowed wins', () => {
    expect(policy.evaluate(bash('cd app && pnpm test'))).toEqual({
      decision: 'allow',
      reason: 'Allowed by the approval policy (`cd`, `pnpm test`).',
      rule: 'cd, pnpm test',
    });
    expect(policy.evaluate(bash('ls && curl x')).decision).toBe('ask');
    expect(policy.evaluate(bash('ls; git push')).decision).toBe('deny');
    expect(policy.evaluate(bash('cat $(rm -rf /)')).decision).toBe('deny');
    expect(policy.evaluate(bash('git status && git status')).rule).toBe('git status');
  });

  it('never allows a command that writes to a file through a redirection', () => {
    expect(policy.evaluate(bash('cat a > /etc/hosts'))).toEqual({
      decision: 'ask',
      reason: '`cat a` writes to a file.',
    });
    expect(policy.evaluate(bash('ls > out.txt; git push')).decision).toBe('deny');
    expect(policy.evaluate(bash('ls 2>/dev/null')).decision).toBe('allow');
  });

  it('falls back on the default for a command it cannot read', () => {
    expect(policy.evaluate({ toolName: 'bash', input: {} })).toEqual({ decision: 'ask' });
    const strict = defineApprovalPolicy({ commands: { default: 'deny' } });
    expect(strict.evaluate({ toolName: 'Bash', input: {} })).toEqual({
      decision: 'deny',
      reason: 'The approval policy does not allow this command.',
    });
    expect(strict.evaluate(bash('ls')).reason).toBe(
      'The approval policy does not allow the command `ls`.',
    );
  });

  it('holds file edits to the path rules', () => {
    expect(policy.evaluate(write('/home/agent/claude-code-1/src/app.ts')).decision).toBe('allow');
    expect(policy.evaluate(write('/home/agent/claude-code-1/src/../.env')).decision).toBe('deny');
    expect(policy.evaluate(write('README.md'))).toEqual({ decision: 'ask' });
    expect(policy.evaluate({ toolName: 'Edit', input: {} })).toEqual({ decision: 'ask' });
  });

  it('decides a tool listed in tools outright', () => {
    expect(policy.evaluate({ toolName: 'deployPreview', input: {} })).toEqual({
      decision: 'ask',
      rule: 'deployPreview',
    });
    expect(policy.evaluate({ toolName: 'dropDatabase', input: {} })).toEqual({
      decision: 'deny',
      reason: 'Never.',
      rule: 'dropDatabase',
    });
    const loose = defineApprovalPolicy({
      tools: {
        bash: 'allow',
        webSearch: 'deny',
        notify: { decision: 'ask', reason: 'Sends mail.' },
      },
    });
    expect(loose.evaluate(bash('rm -rf /')).reason).toBe('Allowed by the approval policy (bash).');
    expect(loose.evaluate({ toolName: 'webSearch', input: {} }).reason).toBe(
      'The approval policy does not allow the tool webSearch.',
    );
    expect(loose.evaluate({ toolName: 'notify', input: {} }).reason).toBe('Sends mail.');
  });

  it('allows the agent its bookkeeping, and holds other tools to the default', () => {
    expect(policy.evaluate({ toolName: 'TodoWrite', input: {} })).toEqual({ decision: 'allow' });
    expect(policy.evaluate({ toolName: 'webFetch', input: {} })).toEqual({ decision: 'ask' });
    expect(defineApprovalPolicy({ default: 'deny' }).evaluate({ toolName: 'x', input: 1 })).toEqual(
      {
        decision: 'deny',
        reason: 'The approval policy does not allow the tool x.',
      },
    );
  });

  it('lets grants allow what it would ask about, never what it denies', () => {
    const grants: ApprovalGrant[] = [
      { kind: 'command', prefix: 'curl' },
      { kind: 'command', prefix: 'git push' },
      { kind: 'edit', path: 'docs/**' },
      { kind: 'tool', toolName: 'webFetch' },
    ];
    expect(policy.evaluate(bash('curl https://example.com'), { grants })).toEqual({
      decision: 'allow',
      reason: 'Allowed for this session: `curl` commands.',
      rule: '`curl` commands',
    });
    expect(policy.evaluate(bash('git push'), { grants }).decision).toBe('deny');
    expect(policy.evaluate(bash('curl x > page.html'), { grants }).decision).toBe('ask');
    expect(policy.evaluate(write('docs/guide.md'), { grants }).decision).toBe('allow');
    expect(policy.evaluate(write('README.md'), { grants }).decision).toBe('ask');
    expect(policy.evaluate(write('README.md'), { grants: [{ kind: 'edit' }] }).decision).toBe(
      'allow',
    );
    expect(policy.evaluate({ toolName: 'webFetch', input: {} }, { grants }).reason).toBe(
      'Allowed for this session: the tool webFetch.',
    );
    expect(
      policy.evaluate(
        { toolName: 'deployPreview', input: {} },
        {
          grants: [{ kind: 'tool', toolName: 'deployPreview' }],
        },
      ).decision,
    ).toBe('allow');
  });
});

describe('ApprovalPolicy.agentSettings', () => {
  const claude = { harnessId: 'claude-code', supportsBuiltinToolApprovals: true };
  const codex = { harnessId: 'codex' };

  it('asks about edits and commands when the policy may restrict edits', () => {
    expect(policy.agentSettings(claude)).toEqual({
      permissionMode: 'allow-reads',
      toolApproval: {
        deployPreview: 'user-approval',
        dropDatabase: { type: 'denied', reason: 'Never.' },
      },
    });
  });

  it('asks about commands only when edits are all allowed', () => {
    const commandsOnly = defineApprovalPolicy({ edits: { default: 'allow' }, default: 'ask' });
    expect(commandsOnly.agentSettings(claude).permissionMode).toBe('allow-edits');
    const noBash = defineApprovalPolicy({ default: 'allow', tools: { bash: 'deny', x: 'deny' } });
    expect(noBash.agentSettings().permissionMode).toBe('allow-edits');
    expect(noBash.agentSettings().toolApproval).toEqual({
      bash: { type: 'denied' },
      x: { type: 'denied' },
    });
  });

  it('asks about nothing when nothing is restricted, or when the harness cannot ask', () => {
    expect(defineApprovalPolicy({ default: 'allow' }).agentSettings(claude).permissionMode).toBe(
      'allow-all',
    );
    expect(policy.agentSettings(codex).permissionMode).toBe('allow-all');
    expect(
      defineApprovalPolicy({ default: 'allow', tools: { Write: 'ask' } }).agentSettings(claude)
        .permissionMode,
    ).toBe('allow-reads');
  });

  it('warns of the rules a harness that cannot ask does not follow', () => {
    expect(policy.warnings(codex)).toEqual([
      'codex does not ask before using its own tools: the rules on commands and edits do not apply, it runs them freely. Rules on your own tools still apply.',
    ]);
    expect(policy.warnings(claude)).toEqual([]);
    expect(defineApprovalPolicy({ default: 'allow' }).warnings(codex)).toEqual([]);
  });
});

describe('ApprovalPolicy.answer and approver', () => {
  it('answers what it decides and leaves the rest', () => {
    const requests = [
      { approvalId: 'a', ...bash('ls') },
      { approvalId: 'b', ...bash('git push') },
      { approvalId: 'c', ...bash('curl x') },
    ];
    const { responses, remaining } = policy.answer(requests);
    expect(responses).toEqual([
      {
        type: 'tool-approval-response',
        approvalId: 'a',
        approved: true,
        reason: 'Allowed by the approval policy (`ls`).',
      },
      {
        type: 'tool-approval-response',
        approvalId: 'b',
        approved: false,
        reason: 'The application publishes the changes.',
      },
    ]);
    expect(remaining).toEqual([requests[2]]);
    expect(
      policy.answer([{ approvalId: 'd', toolName: 'TodoWrite', input: {} }]).responses,
    ).toEqual([{ type: 'tool-approval-response', approvalId: 'd', approved: true }]);
  });

  it('decides as the approve option of a session manager, with the grants of the session', () => {
    const approve = policy.approver<{ session: { metadata: { grants?: ApprovalGrant[] } } }>({
      grants: ({ session }) => session.metadata.grants,
    });
    const granted = {
      session: { metadata: { grants: [{ kind: 'command', prefix: 'curl' }] as ApprovalGrant[] } },
    };
    expect(approve(bash('curl x'), { session: { metadata: {} } })).toBeUndefined();
    expect(approve(bash('curl x'), granted)).toEqual({
      approved: true,
      reason: 'Allowed for this session: `curl` commands.',
    });
    expect(policy.approver()(bash('git push'), undefined)).toEqual({
      approved: false,
      reason: 'The application publishes the changes.',
    });
  });
});
