---
'ai-sdk-sandbox-sbx': patch
---

A failed `setup` command is named in the error, `Setup command \`…\` exited with <code>: <stderr>`, as the Compute Engine, Cloud Run and microsandbox sandboxes name it, rather than `` `sbx exec`exited with <code> ``: the caller can tell which of its commands failed, a template's setup included. The error is still an`SbxError`, with the same `args`, `exitCode`and`stderr`.
