---
'ai-sdk-harness-sessions': patch
---

Closing or deleting an `interrupted` session now discards its sandbox, as it does for a `suspended` one. A session the process left live when it stopped without suspending it kept its sandbox forever: with `sandboxPerSession()`, a session created again under the same id then failed, its sandbox's name already taken.
