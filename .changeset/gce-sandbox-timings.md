---
'ai-sdk-sandbox-gce': minor
---

`timings` of a session says how long its creation or its resume took on the service, step by step: the egress proxy, Compute Engine making or starting the machine (or the warm pool handing one over, `fromPool`), its boot until the agent answered, then the agent's configuration, and the whole call. The service answers it with the sandbox, in the create and resume responses.
