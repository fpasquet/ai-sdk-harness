---
'ai-sdk-harness-sessions': patch
---

A resume that fails no longer closes the session's sandbox lease: it hands it back with `suspend()`, as a suspension does, so the sandbox and the files the next try resumes from are kept. With `sandboxPerSession()`, a failed resume destroyed the session's sandbox while the session stayed `suspended`, waiting to resume from it.
