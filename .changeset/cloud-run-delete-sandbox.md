---
'ai-sdk-sandbox-cloud-run': patch
---

`deleteCloudRunSandbox()` deletes a sandbox by its id, and its snapshot, without restoring it: `destroy()` needs a session, which resumes a suspended sandbox onto a billed instance only to delete it. A sandbox that does not exist, or no longer does, is no error. It is the `remove` of `sandboxPerSession()` of `ai-sdk-harness-sessions`, for the sessions closed while suspended.
