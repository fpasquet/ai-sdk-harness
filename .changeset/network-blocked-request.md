---
'ai-sdk-harness-network': patch
---

`BlockedRequest` is the shape of a request the network policy refused — the host, the port when known, the time and the command that sent it when the sandbox knows it — for a sandbox's proxy to log and an application to show. With `originOf()` of `networkLayers()`, it tells a user which host to allow, and in which list.
