import { describe, expect, it } from 'vitest';

import { describeToolCall, TOOL_CALL_TITLES } from './describe-tool-call.js';

describe('describeToolCall', () => {
  it('shows the command a command tool runs', () => {
    expect(describeToolCall({ toolName: 'bash', input: { command: 'uname -a' } })).toEqual({
      kind: 'command',
      action: 'run-command',
      title: 'Run a command',
      detail: 'uname -a',
    });
    expect(describeToolCall({ toolName: 'bash', input: {} }).detail).toBe('');
  });

  it('shows the files an edit writes', () => {
    expect(describeToolCall({ toolName: 'write', input: { file_path: 'a.ts' } })).toEqual({
      kind: 'edit',
      action: 'write-file',
      title: 'Write a file',
      detail: 'a.ts',
    });
    expect(
      describeToolCall({ toolName: 'Edit', input: { file_path: 'a.ts', path: 'b.ts' } }),
    ).toEqual({ kind: 'edit', action: 'edit-files', title: 'Edit files', detail: 'a.ts, b.ts' });
    expect(
      describeToolCall({ toolName: 'NotebookEdit', input: { notebook_path: 'src/../a.ipynb' } }),
    ).toEqual({ kind: 'edit', action: 'edit-file', title: 'Edit a file', detail: 'a.ipynb' });
  });

  it.each([
    ['Read', { file_path: '/repo/src/a.ts' }, 'read-file', 'Read a file', '/repo/src/a.ts'],
    ['read', { file_path: 'a.ts', offset: 10 }, 'read-file', 'Read a file', 'a.ts'],
    ['Glob', { pattern: 'src/**/*.ts', path: '/repo' }, 'find-files', 'Find files', 'src/**/*.ts'],
    ['Grep', { pattern: 'TODO', glob: '*.ts' }, 'search-files', 'Search files', 'TODO'],
    [
      'WebFetch',
      { url: 'https://x.dev', prompt: '…' },
      'fetch-url',
      'Fetch a web page',
      'https://x.dev',
    ],
    ['webFetch', { url: 'https://x.dev' }, 'fetch-url', 'Fetch a web page', 'https://x.dev'],
    ['WebSearch', { query: 'vitest' }, 'search-web', 'Search the web', 'vitest'],
    ['webSearch', '{"query":"vitest"}', 'search-web', 'Search the web', 'vitest'],
  ])('shows what %s acts on', (toolName, input, action, title, detail) => {
    expect(describeToolCall({ toolName, input })).toEqual({ kind: 'other', action, title, detail });
  });

  it('shows a tool it does not know that takes a command as a command', () => {
    expect(
      describeToolCall({ toolName: 'mcp__shell__run', input: { command: ['ls', '-la'] } }),
    ).toEqual({ kind: 'command', action: 'run-command', title: 'Run a command', detail: 'ls -la' });
  });

  it('shows the input of any other tool, in short', () => {
    expect(describeToolCall({ toolName: 'deploy', input: { env: 'prod' } })).toEqual({
      kind: 'other',
      action: 'other',
      title: 'deploy',
      detail: '{"env":"prod"}',
    });
    expect(describeToolCall({ toolName: 'Read', input: { path: 1 } }).action).toBe('other');
    expect(describeToolCall({ toolName: 'x', input: 'raw' }).detail).toBe('raw');
    expect(describeToolCall({ toolName: 'x', input: undefined }).detail).toBe('');
    expect(describeToolCall({ toolName: 'x', input: 'y'.repeat(500) }).detail).toHaveLength(400);
  });

  it('cuts the detail where it is told to, or keeps it whole', () => {
    const request = { toolName: 'bash', input: { command: 'y'.repeat(500) } };
    expect(describeToolCall(request, { maxDetail: 10 }).detail).toBe(`${'y'.repeat(9)}…`);
    expect(describeToolCall(request, { maxDetail: Infinity }).detail).toHaveLength(500);
  });

  it('gives the titles in another language, an action left out in English', () => {
    const titles = { 'run-command': 'Lancer une commande', 'read-file': 'Lire un fichier' };
    expect(describeToolCall({ toolName: 'bash', input: { command: 'ls' } }, { titles }).title).toBe(
      'Lancer une commande',
    );
    expect(describeToolCall({ toolName: 'Glob', input: { pattern: '*' } }, { titles }).title).toBe(
      TOOL_CALL_TITLES['find-files'],
    );
    expect(describeToolCall({ toolName: 'deploy', input: {} }, { titles }).title).toBe('deploy');
  });
});
