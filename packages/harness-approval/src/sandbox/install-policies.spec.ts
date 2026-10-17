import { describe, expect, it, vi } from 'vitest';

import { defineApprovalPolicy } from '../policy/approval-policy.js';
import { installClaudeCodePolicies } from './install-policies.js';

const sandbox = () => ({
  run: vi.fn(() => Promise.resolve({ exitCode: 0, stdout: '', stderr: '' })),
  writeTextFile: vi.fn(() => Promise.resolve()),
});

describe('installClaudeCodePolicies', () => {
  it('refuses a policy that may ask a person, before touching the sandbox', async () => {
    const box = sandbox();

    await expect(
      installClaudeCodePolicies(box, {
        asking: defineApprovalPolicy({ commands: { allow: ['ls'] } }),
      }),
    ).rejects.toThrow(/cannot ask a person/);
    expect(box.writeTextFile).not.toHaveBeenCalled();
    expect(box.run).not.toHaveBeenCalled();
  });

  it('refuses a name that could not be a file of the sandbox', async () => {
    const policy = defineApprovalPolicy({ default: 'deny' });

    await expect(installClaudeCodePolicies(sandbox(), { '../etc': policy })).rejects.toThrow(
      /Invalid policy name/,
    );
  });
});
