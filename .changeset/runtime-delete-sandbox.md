---
'ai-sdk-sandbox-runtime': patch
---

`deleteSrtSandbox()` removes a sandbox by its id, its directory with its home and working directory, without starting its supervisor; a directory that holds no sandbox is refused. A sandbox that does not exist, or no longer does, is no error. It is the `remove` of `sandboxPerSession()` of `ai-sdk-harness-sessions`, for the sessions closed while suspended.
