---
'ai-sdk-sandbox-gce': patch
---

The egress proxy has a total limit of connections, for all its sandboxes: `SANDBOX_PROXY_TOTAL_CONNECTIONS`, by default what its file descriptors allow (two for each connection, 1024 kept apart: 32256 under `LimitNOFILE=65536`). Without it, once the descriptors ran out, the system reset every sandbox's new connections before the proxy saw them, and nothing was logged. Beyond the limit, a connection is now refused with a `503` that says the proxy is full, and a tenth of the total is kept for the base URL routes. The proxy logs when it reaches its limit, with the three sandboxes that hold the most connections, and when it goes back under.
