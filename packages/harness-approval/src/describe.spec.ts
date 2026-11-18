import { describe, expect, it } from 'vitest';

import * as entry from './describe.js';

describe('ai-sdk-harness-approval/describe', () => {
  it('reads a tool call', () => {
    expect(Object.keys(entry).sort()).toEqual([
      'TOOL_CALL_TITLES',
      'commandOf',
      'commandSegments',
      'describeToolCall',
      'pathsOf',
      'toolKindOf',
    ]);
    expect(entry.commandOf('Bash', { command: 'git status' })).toBe('git status');
    expect(entry.pathsOf('{"file_path":"src/./a.ts"}')).toEqual(['src/a.ts']);
  });
});
