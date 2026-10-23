---
'ai-sdk-sandbox-sbx': patch
---

`blockedRequests({ since?, abortSignal? })` on a local `SbxNetworkSandboxSession` lists the hosts the Docker Sandboxes proxy refused to the sandbox, the last refused first, from `sbx policy log`: the host, the port, the proxy's reason, how many requests it refused and when it first and last did. An application can tell a person which host its network policy blocked, and let them allow it. The log is kept by sandbox name and outlives the sandbox: pass `since` to leave older refusals out. Absent on a cloud sandbox, like `setNetworkPolicy`.
