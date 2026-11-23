---
'ai-sdk-sandbox-gce': minor
---

The commands of a sandbox no longer get `NODE_USE_ENV_PROXY=1` by default. It sent Node.js's own `fetch` and `http` to the egress proxy, where a test suite that mocks `fetch` with MSW 3 no longer saw its requests: they reached the proxy, which refused them (`fetch failed`, `Failed to establish tunnel … 403`). Package managers, git, curl and the harnesses still leave through the proxy, as they read `HTTPS_PROXY` themselves. The agent sets the variables: build the sandbox image again on this version for the change to take effect.

BREAKING: Node.js code in a sandbox that calls an outside host with its own `fetch` or `http`, rather than through a base URL, and has no proxy support of its own, can no longer reach it. Set the variable again with `nodeUseEnvProxy: true` on the sandbox (at its creation and at each resume), or `SANDBOX_NODE_USE_ENV_PROXY=true` on the service for every sandbox; for one command, `NODE_USE_ENV_PROXY=1 <command>` or `node --use-env-proxy`.
