---
'ai-sdk-sandbox-gce': minor
---

`describeGceSandbox({ url, sandboxId })`, and `describe()` of a session, read the sandbox's machine from Compute Engine without starting it (`GET /v1/sandboxes/:name` on the service): when it was made, last started and last stopped, whether it is billed as Spot or standard (`spotFallback` says when a service of Spot machines fell back to a standard one), its machine type, the size of its disk, its image, whether it came from the warm pool, and the caller's labels.
