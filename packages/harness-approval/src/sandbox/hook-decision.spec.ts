import { describe, expect, it } from 'vitest';

import type { ApprovalPolicySettings } from '../definitions/policy.js';

import { hookDecision } from './hook-decision.js';

const READ_ONLY: ApprovalPolicySettings = {
  commands: {
    allow: ['ls', 'cat', 'git log'],
    deny: [{ match: 'git push', reason: 'The application publishes.' }],
  },
  edits: { deny: [{ match: '**', reason: 'This agent only reads.' }] },
  tools: { WebSearch: 'allow', webFetch: 'deny' },
  default: 'deny',
};

const call = (tool_name: string, tool_input: unknown) =>
  hookDecision(READ_ONLY, { tool_name, tool_input });

describe('hookDecision', () => {
  it('allows a command the policy allows', () => {
    expect(call('Bash', { command: 'git log --oneline -5' })).toEqual({
      decision: 'allow',
      reason: 'Allowed by the approval policy (`git log`).',
    });
  });

  it('denies a command the policy denies, with its reason', () => {
    expect(call('Bash', { command: 'git push origin main' })).toEqual({
      decision: 'deny',
      reason: 'The application publishes.',
    });
    expect(call('Bash', { command: 'ls && rm -rf src' })?.decision).toBe('deny');
  });

  it('denies a command no rule allows, under a default deny', () => {
    expect(call('Bash', { command: 'curl https://example.com' })).toMatchObject({
      decision: 'deny',
    });
  });

  it('denies what the policy would ask a person about, saying why', () => {
    expect(call('Bash', { command: 'cat a > b' })).toEqual({
      decision: 'deny',
      reason:
        '`cat a` writes to a file. The approval policy would ask a person, and nobody can be asked from the sandbox.',
    });
  });

  it('denies an edit the policy denies', () => {
    expect(call('Edit', { file_path: '/home/agent/workspace/src/a.ts' })).toEqual({
      decision: 'deny',
      reason: 'This agent only reads.',
    });
    expect(call('Write', { file_path: 'notes.md', content: '' })?.decision).toBe('deny');
  });

  it('decides the built-in tools the policy names, as Claude Code or the stream names them', () => {
    expect(call('WebSearch', { query: 'ai sdk' })?.decision).toBe('allow');
    expect(call('WebFetch', { url: 'https://example.com' })?.decision).toBe('deny');
  });

  it('leaves reads, bookkeeping and your own tools to Claude Code', () => {
    expect(call('Read', { file_path: 'src/a.ts' })).toBeUndefined();
    expect(call('Grep', { pattern: 'x' })).toBeUndefined();
    expect(call('TodoWrite', { todos: [] })).toBeUndefined();
    expect(call('mcp__harness-tools__proposeDraft', {})).toBeUndefined();
    expect(hookDecision(READ_ONLY, {})).toBeUndefined();
  });
});
