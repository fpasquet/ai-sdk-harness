---
'ai-sdk-sandbox-docker-engine': minor
---

First release: sandbox sessions for harness agents on Docker Engine. `createDockerNetworkSandboxSession({ image, mounts, limits, networkPolicy, ports })` runs a container of any image on an `--internal` Docker network of its own, whose only way out is an egress proxy beside it: it lets through the hosts of the network policy, read again at each connection (`setNetworkPolicy()` applies to the next one), never connects to a private address, and logs what it refuses, which `blockedRequests({ since })` reads back with the host, port, time and reason. The ports a harness bridge listens on are forwarded by the proxy and published on this host's loopback; both containers run with no capability, within limits of memory, processors and processes. `resumeDockerNetworkSandboxSession({ sandboxId })` starts a stopped sandbox again. Credentials are not brokered yet: the harness forwards them into the sandbox.
