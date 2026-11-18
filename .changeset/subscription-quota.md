---
'ai-sdk-harness-sessions': patch
---

`subscriptionQuota(event)` reads the use of a Claude subscription from a raw event of Claude Code: the `status` and every window of a `rate_limit_event` (`five_hour`, `seven_day`…), each with its `utilization`, its `percent` and its `resetsAt`. It reads the `SDKRateLimitInfo` of the Claude Agent SDK as well, and gives `undefined` for any other event.

`onRawEvent`, a new option of `createSessionManager()`, gets each raw event of the harness while the turn runs, with `interrupt(reason?)` to cut the turn short, the reason its failure: stop a turn once a window of the subscription passes a threshold. It is not awaited, and what it throws goes to `onError`.
