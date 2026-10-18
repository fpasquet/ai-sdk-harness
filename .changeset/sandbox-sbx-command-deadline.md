---
'ai-sdk-sandbox-sbx': patch
---

A control command of `sbx` that hangs no longer holds the caller: listing, publishing a port, stopping or removing the sandbox and the package's own short commands in it are stopped after `commandTimeoutMs` (60 seconds by default) and fail with `SbxTimeoutError`. Creating the sandbox, its `setup`, file reads and writes and the agent's commands have no deadline, as before.

A signed-out `sbx`, or one whose Docker sign-in expired, now fails with `SbxNotSignedInError`, which says to run `sbx login`; for 30 seconds after, the other commands of the same sandbox fail with it at once instead of running `sbx` again, so a cleanup after the failure no longer waits for minutes.
