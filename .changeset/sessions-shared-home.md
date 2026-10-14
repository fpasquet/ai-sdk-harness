---
'ai-sdk-harness-sessions': patch
---

`SessionSandboxes` gets `shared`, which `sharedSandbox()` sets: its sessions share the sandbox's HOME, where Claude Code and Codex write the skills of their agent at each turn, so agents with different skills must not run in it at the same time.
