---
'ai-sdk-sandbox-gce': patch
---

`prepareGceSandboxService({ url, auth })` has the service boot its egress proxy ahead of a sandbox, when it starts and stops it (`SANDBOX_PROXY_INSTANCE`), without waiting for it: call it as soon as a sandbox is likely to be asked for, and the sandbox finds the proxy up rather than waiting some 40 s for its machine. The service answers it at `POST /v1/prepare`; a service of an earlier version answers 404, which the client takes as nothing to do.

Should no sandbox come, the proxy exits after `SANDBOX_PROXY_IDLE_EXIT_MINUTES` with no sandbox, with the exit code 100, on which the unit of the README stops its machine: set to 10 minutes there. The proxy never exits by itself without the variable: leave it out of the unit of a proxy always on.
