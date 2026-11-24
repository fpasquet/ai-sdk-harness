---
'ai-sdk-harness-plugins': patch
---

`withPlugins()` takes `ownSandbox`, for an application whose sessions each have a sandbox of their own, as with `sandboxPerSession()` of `ai-sdk-harness-sessions` (`ownSandbox: sandboxes.ownSandboxes`). On Claude Code, the hooks of plugins then go to `$HOME/.claude/settings.json` as the plugins declare them, without the gate that keeps the sessions of a shared sandbox apart: a `prompt` hook now runs, on `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `UserPromptSubmit`, `Stop` and `SubagentStop`, the events Claude Code takes one on, and is still reported to `onUnsupported` on another. At each start and resume, the session's hooks replace those the plugins wrote before, through the gate or not; a hook of the file the plugins did not write stays. Without the option, nothing changes.
