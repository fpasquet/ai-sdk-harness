---
'ai-sdk-sandbox-sbx': patch
---

`deleteSbxSandbox()` removes a sandbox by its id, with its files and its secrets, without starting it: `destroy()` needs a session, which resumes a stopped sandbox, booting its microVM only to remove it. A sandbox that does not exist, or no longer does, is no error. It is the `remove` of `sandboxPerSession()` of `ai-sdk-harness-sessions`, for the sessions closed while suspended.
