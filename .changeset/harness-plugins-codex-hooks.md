---
'ai-sdk-harness-plugins': minor
---

Codex takes the plugins' hooks. Codex runs no hook it has not trusted by its hash, so they go to the adapter rather than to the session: `pluginHarnessSettings('codex', plugins)` now returns a `codexConfig` with the hooks, `${PLUGIN_ROOT}` relative to the session's working directory, and the state that trusts each one by the hash Codex computes. Codex takes command hooks on `PreToolUse`, `PostToolUse`, `PreCompact`, `SessionStart`, `SessionEnd`, `Stop`, `SubagentStart`, `SubagentStop` and `UserPromptSubmit`; a prompt hook, or one on `Notification` or `PostToolUseFailure`, is left out and reported to `onUnsupported`, whose report now names it in `hook`. The catalog's `unsupportedOn` follows, hook by hook.

BREAKING: on Codex, spread `pluginHarnessSettings('codex', plugins)` into `createCodex()` for the hooks to run, and merge your own `codexConfig` into its `codexConfig` rather than replacing it; `onUnsupported` is called once per hook Codex leaves out, instead of once for all of a plugin's hooks.
