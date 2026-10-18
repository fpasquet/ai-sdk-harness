---
'ai-sdk-harness-sessions': minor
---

`onTurn`, a new option of `createSessionManager()`, is called once each turn is over and the session written, with a `TurnReport`: the turn's tokens, cache reads and writes included, the model, tokens and tool calls of each step, and the raw events of its harness — Claude Code's `rate_limit_event`, for instance. An application can account for its sessions, and read the rate limits of a subscription. `SessionStreamResult` may give `steps` and `fullStream`, as a `StreamTextResult` does; an agent whose results give neither reports its tokens only.
