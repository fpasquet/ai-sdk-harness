---
'ai-sdk-sandbox-gce': patch
---

The egress proxy keeps connections for the base URL routes: the runtime reaches its model provider while the commands of its sandbox hold every connection they may. `SANDBOX_PROXY_MAX_CONNECTIONS` (128) now bounds the commands' tunnels and plain HTTP requests, and `SANDBOX_PROXY_ROUTE_CONNECTIONS` (32) gives the routes that many more; no machine holds more than both together. A command refused at its limit gets a `503` that says why, rather than a reset connection. The proxy logs a warning when a sandbox reaches a limit, and a line when it goes back under, with how many connections it refused meanwhile. A tunnel whose client ends it before its TLS ClientHello now frees its connection at once, rather than after 10 seconds.
