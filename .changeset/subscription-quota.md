---
'ai-sdk-harness-sessions': patch
---

`subscriptionQuota(event)` reads the use of a Claude subscription from a raw event of Claude Code: the `status` and every window of a `rate_limit_event` (`five_hour`, `seven_day`…), each with its `utilization`, its `percent` and its `resetsAt`. It reads the `SDKRateLimitInfo` of the Claude Agent SDK as well, and gives `undefined` for any other event.
