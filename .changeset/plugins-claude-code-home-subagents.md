---
'ai-sdk-harness-plugins': patch
---

Subagents reach Claude Code again: `withPlugins()` writes them in `.claude/agents/` under the sandbox's `$HOME`, rather than in the session's `.claude/`. `@ai-sdk/harness-claude-code` 1.0.180 and later starts Claude Code with the user's settings alone (`settingSources: ['user']`), so it read none of the session's subagents, and delegating to one failed. The sessions of a sandbox share these files: the last one to start or resume decides which subagents there are. A file of the same name the plugins did not write is never overwritten: the session fails to start instead. The subagents an earlier version wrote in a session are taken back when it resumes. Hooks still wait for the adapter to read the session's settings ([vercel/ai#21714](https://github.com/vercel/ai/pull/21714)).
