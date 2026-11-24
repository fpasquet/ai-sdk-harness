---
'ai-sdk-harness-plugins': patch
---

Hooks reach Claude Code again: `withPlugins()` adds them to `.claude/settings.json` under the sandbox's `$HOME` rather than to the session's `.claude/settings.local.json`, which `@ai-sdk/harness-claude-code` 1.0.180 and later no longer has Claude Code read (`settingSources: ['user']`). Every session of the sandbox reads that file, so each hook goes through a gate, `$HOME/.ai-sdk-harness/hook-gate.sh`, which runs the command the session holds for it, with its own `${PLUGIN_ROOT}`, and does nothing in a session without it. The hooks an earlier version wrote in a session are taken back when it resumes. A `prompt` hook has no command for the gate, and is now left out on Claude Code, as on Codex, and reported to `onUnsupported`.
