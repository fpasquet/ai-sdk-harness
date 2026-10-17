---
'ai-sdk-harness-sessions': patch
---

The message sent after a turn cut short is answered. Claude Code goes on with a turn for a moment after it is told to stop, and the harness session handed what it still said to the next turn: that turn failed with "Received text-delta for missing text part", or ended at once without its answer. A turn cut short by `interrupt()`, `turnTimeoutMs` or the caller's `abortSignal` now starts its harness session again, in the same sandbox and the same conversation, before the next turn.
