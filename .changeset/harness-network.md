---
'ai-sdk-harness-network': minor
---

First release: the hosts the sandbox of a harness agent may reach, so that its network can be closed to everything else. `trustedHosts('github', 'npm', 'yarn', 'pypi')` gives the hosts of each service, the domain named beside each wildcard; `harnessHosts(harness.harnessId)` those Claude Code and Codex call; `networkPolicy(...lists)` checks and merges them, with those of a workspace and of plugins, into `{ mode: 'custom', allowedHosts }`. `isAllowedHost()` and `InvalidHostError` refuse what a network policy cannot take: a scheme, a path, a port, `*` or `*.com`.
