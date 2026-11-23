---
'ai-sdk-harness-sessions': patch
---

The `approve` option gets the turn's `abortSignal` beside the session, which aborts when the turn is interrupted, takes longer than `turnTimeoutMs`, or its session is closed or shut down: an `approve` that waits for a person answering elsewhere can settle then, rather than hold the turn, and `interrupt()`, back.
