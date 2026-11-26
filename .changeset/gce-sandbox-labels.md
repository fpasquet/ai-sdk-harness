---
'ai-sdk-sandbox-gce': minor
---

`createGceNetworkSandboxSession()` takes `labels`, put on the sandbox's machine and on its disk beside the service's own, for a Cloud Billing export or a budget to group their cost by. Keys starting with `ai-sdk-` are refused, and so are labels Compute Engine would refuse. A machine taken from the warm pool gets them as it is taken, and so does its disk, now labelled `ai-sdk-sandbox=pool` until then and `ai-sdk-sandbox-name=<sandbox>` after.
