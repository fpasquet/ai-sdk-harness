---
'ai-sdk-harness-approval': patch
---

A policy that never asks a person can be held by the sandbox itself, with Claude Code: `installClaudeCodePolicies(sandbox, { name: policy })`, from the new `ai-sdk-harness-approval/sandbox` entry, installs a `PreToolUse` hook in Claude Code's managed settings, root's files the agent cannot change, and `policy.claudeCodeSandbox(name)` gives the settings of `createClaudeCode()` and `HarnessAgent` for an agent held to it. Each command and edit is allowed or denied before Claude Code runs it, the agent told why: the turn never pauses for an approval, which also keeps clear of two bugs of the Claude Code harness around approvals (vercel/ai#23499, vercel/ai#23503).
