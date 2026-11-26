---
'ai-sdk-sandbox-gce': patch
---

The README closes the sandboxes' DNS with a private zone for the root, which answers every type of query in the network, rather than a response policy rule on `*.`, which answered only `A` queries and let the others (`AAAA`, `TXT`, `MX`…) leave it, a channel for a few bytes at a time. A peering zone keeps `googleapis.com` resolving for the service. A network set up with the earlier steps should move to the zones, as the README shows.
