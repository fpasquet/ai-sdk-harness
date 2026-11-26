---
'ai-sdk-sandbox-gce': minor
---

The egress proxy counts the bytes each sandbox's connections carry, outside its machine. `usage()` of a session, or `getGceSandboxUsage()`, reads the count while the sandbox runs (`GET /v1/sandboxes/:name/usage` on the service, `GET /v1/sandboxes/:name/usage` on the proxy's administration API). The proxy keeps it in memory and forgets it with the sandbox: a stop and a deletion now answer the last count in a report (`POST …/suspend` and `DELETE /v1/sandboxes/:name` answer 200 with it, no longer 204), which `onUsageReport` is handed (by `stop()`, `destroy()` and `deleteGceSandbox()`) and `lastReport` of the session holds. Upgrade the proxy with the service: one of an earlier version counts nothing.
