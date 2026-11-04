---
'ai-sdk-sandbox-gce': minor
---

Four mechanisms go, whose cost outweighed what they protected against, the sandbox and the proxy being the boundary:

- The proxy no longer counts the bytes each sandbox moves: nothing but a log line read them. `GET /v1/sandboxes` goes with it, as does its `?serial=` on `DELETE`.
- The service no longer makes the proxy forget the sandboxes whose machine stopped without it, and `SANDBOX_RECONCILE_MINUTES` is gone: `stop()` and `destroy()` still do so at once, and a new machine on the same address takes the place of the old one in the proxy.
- An agent keeps its token for as long as its machine lives, rather than get a new one at each `stop()`. A machine made by 0.3.0 to 0.3.6 keeps the token it has.
- The agent no longer sets `OOMPolicy=continue` on its running service: the line belongs to the unit of the sandbox image, as the README has it. Keep it there, or a command out of memory stops every command of the sandbox.
