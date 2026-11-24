---
'ai-sdk-harness-workspace': patch
---

`workspace.sandboxes()` no longer starts the sandbox of a session closed while suspended to remove its checkout, when that sandbox is the session's own (`ownSandboxes`, as `sandboxPerSession()` of `ai-sdk-harness-sessions` 0.4.4 says): the checkout goes with the sandbox its `discard` deletes.
