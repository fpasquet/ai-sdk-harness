// The `PreToolUse` hook that `installClaudeCodePolicies()` installs in the sandbox: Claude Code
// runs it with Node.js before each tool call, the call on its standard input, and reads its
// answer on its standard output. The policy is the one its environment names.
import { readFileSync } from 'node:fs';

import type { ApprovalPolicySettings } from '../definitions/policy.js';
import type { HookDecision, HookInput } from './hook-decision.js';

import { POLICY_ENV, POLICY_NAME } from '../definitions/sandbox.js';
import { hookDecision } from './hook-decision.js';

/** The policies sit beside the hook: `<dir>/policies/<name>.json`, `<dir>/hook/sandbox/hook-main.js`. */
const POLICIES = new URL('../../policies/', import.meta.url);

/** What the hook makes of a call: denied when its policy is named but cannot be read. */
function decide(name: string, raw: string): HookDecision | undefined {
  let settings: ApprovalPolicySettings;
  try {
    if (!POLICY_NAME.test(name)) throw new Error(`invalid name ${name}`);
    settings = JSON.parse(
      readFileSync(new URL(`${name}.json`, POLICIES), 'utf8'),
    ) as ApprovalPolicySettings;
  } catch {
    return {
      decision: 'deny',
      reason: `The approval policy ${name} is not installed in the sandbox: nothing runs without it.`,
    };
  }
  let input: HookInput;
  try {
    input = JSON.parse(raw) as HookInput;
  } catch {
    return { decision: 'deny', reason: 'The approval policy could not read the tool call.' };
  }
  return hookDecision(settings, input);
}

const name = process.env[POLICY_ENV];
// An agent without a policy: Claude Code decides, as it would without the hook.
if (name !== undefined && name !== '') {
  const chunks: Buffer[] = [];
  process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
  process.stdin.on('end', () => {
    const decision = decide(name, Buffer.concat(chunks).toString('utf8'));
    if (decision === undefined) return;
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: decision.decision,
          permissionDecisionReason: decision.reason,
        },
      }),
    );
  });
}
