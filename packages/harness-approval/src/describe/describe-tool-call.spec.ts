import { describe, expect, it } from 'vitest';

import { describeToolCall } from './describe-tool-call.js';

describe('describeToolCall', () => {
  it('shows the command a command tool runs', () => {
    expect(describeToolCall({ toolName: 'bash', input: { command: 'uname -a' } })).toEqual({
      kind: 'command',
      title: 'Run a command',
      detail: 'uname -a',
    });
    expect(describeToolCall({ toolName: 'bash', input: {} }).detail).toBe('');
  });

  it('shows the files an edit writes', () => {
    expect(describeToolCall({ toolName: 'write', input: { file_path: 'a.ts' } })).toEqual({
      kind: 'edit',
      title: 'Write a file',
      detail: 'a.ts',
    });
    expect(
      describeToolCall({ toolName: 'Edit', input: { file_path: 'a.ts', path: 'b.ts' } }),
    ).toEqual({ kind: 'edit', title: 'Edit files', detail: 'a.ts, b.ts' });
  });

  it('shows the input of any other tool, in short', () => {
    expect(describeToolCall({ toolName: 'webFetch', input: { url: 'https://x' } })).toEqual({
      kind: 'other',
      title: 'webFetch',
      detail: '{"url":"https://x"}',
    });
    expect(describeToolCall({ toolName: 'x', input: 'raw' }).detail).toBe('raw');
    expect(describeToolCall({ toolName: 'x', input: undefined }).detail).toBe('');
    expect(describeToolCall({ toolName: 'x', input: 'y'.repeat(500) }).detail).toHaveLength(400);
  });
});
