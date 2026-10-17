/**
 * The variable that names, in the environment of Claude Code, the approval policy the sandbox
 * holds it to: `policy.claudeCodeSandbox(name)` sets it, the hook installed in the sandbox reads it.
 */
export const POLICY_ENV = 'AI_SDK_HARNESS_APPROVAL_POLICY';

/** What a policy may be named, in the environment and as the file of the sandbox that holds it. */
export const POLICY_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
