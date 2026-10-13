---
'ai-sdk-sandbox-sbx': patch
---

A local sandbox takes a harness `networkPolicy` at creation, and `setNetworkPolicy()` replaces it while it runs: rules of the Docker Sandboxes policy scoped to the sandbox, on top of the machine's. `custom` allows the listed hosts and blocks only, denying what the machine allows besides; `deny-all` denies every host; `allow-all` is the machine's policy as it is, which keeps private networks and the metadata server out of reach. The README warns about the files an agent writes in a read-write `workspace`, and links the upstream issues behind the remaining limits.
