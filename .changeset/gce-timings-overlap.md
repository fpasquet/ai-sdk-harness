---
'ai-sdk-sandbox-gce': patch
---

A sandbox's `timings` count the registration with the egress proxy once: it runs alongside the boot, and `agentMs` now holds only what it took beyond the boot, so that `insertMs`, `bootMs` and `agentMs` follow one another within `totalMs`, as documented.
