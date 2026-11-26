---
'ai-sdk-sandbox-gce': minor
---

A creation or a resume refused for `SANDBOX_MAX_RUNNING` now throws `GceSandboxCapacityError`, carrying `running`, `max` and `retryAfterSeconds`, for the caller to queue the call rather than read the message. It extends `GceSandboxServiceError`, its `status` still 429. The service answers that 429 with `code: 'SANDBOX_MAX_RUNNING'`, `running`, `max` and `retryAfterSeconds` in its body, and a `Retry-After` header.
