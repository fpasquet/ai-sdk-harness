---
'ai-sdk-sandbox-gce': patch
---

`deleteGceSandbox({ url, sandboxId })` deletes a sandbox by its id, its machine and its disk, without starting it: `destroy()` needs a session, which resumes a stopped sandbox, a minute of a billed machine only to delete it. A sandbox that does not exist, or no longer does, is no error. It is the `remove` of `sandboxPerSession()` of `ai-sdk-harness-sessions`.
