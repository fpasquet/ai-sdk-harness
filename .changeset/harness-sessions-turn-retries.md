---
'ai-sdk-harness-sessions': patch
---

`turnRetries`, a new option of `createSessionManager()`, runs a turn again when it fails on a transient error: the harness bridge lost, a connection reset or timed out, a 5xx or an overloaded provider. The harness session starts again from where it stopped, in the same sandbox, and the agent is told to carry on, its conversation kept; the client reads one answer, told of each retry by a transient `data-turn-retry` chunk rather than the error. `attempts` sets how many times (off by default, so nothing changes until you set it), `delayMs` the waits (10 seconds, doubled at each retry), `isTransient` which errors count and `prompt` what the agent is told. `isTransientError(error)` is exported for the applications that retry on their own, and `TurnReport.retries` counts the retries of a turn.
