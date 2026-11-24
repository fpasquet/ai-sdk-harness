---
'ai-sdk-harness-plugins': patch
---

Rules now reach Claude Code: they join the agent's instructions, as on Codex, rather than files of the session's `.claude/rules/`. `@ai-sdk/harness-claude-code` 1.0.180 and later starts Claude Code with the user's settings alone (`settingSources: ['user']`), so it read none of those files, and a plugin's rules were silently ignored. A rule with `paths` now says, in the instructions, which files it is for.

The same adapter change keeps Claude Code from running the hooks and subagents of plugins, which the package writes in the session's `.claude/` too: they are still written, for the adapters before 1.0.180 and for the day the adapter lets the setting be chosen ([vercel/ai#21714](https://github.com/vercel/ai/pull/21714)), and the README says so in its limitations. Codex runs them.
