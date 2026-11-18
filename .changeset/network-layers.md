---
'ai-sdk-harness-network': patch
---

`networkLayers({ locked, general, sources })` merges the hosts the harness cannot run without, a general list and the hosts of each named source (a repository, a project) into the `allowedHosts` of a network policy, and `originOf(host)` tells which of those layers allow a host: why a settings page shows it, which list to add a refused one to. It matches a host as `matchesHost()` does.
