---
'ai-sdk-harness-sessions': patch
---

`sandboxPerSession()` takes `remove(sessionId)`, which deletes the sandbox of a session closed while it was suspended without starting it again: its `discard` used to resume the sandbox, then destroy it, which started a stopped Compute Engine machine for a minute only to delete it, and turned a sandbox already gone into a failed resume. Without `remove`, it resumes then destroys, as before. Its sandboxes also say they are each session's own (`ownSandboxes` of `SessionSandboxes`), for a wrapper to leave what it keeps in one to go with it.
