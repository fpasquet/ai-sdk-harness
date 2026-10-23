---
'ai-sdk-harness-network': minor
---

First release: the hosts the sandbox of a harness agent may reach, so that its network can be closed to everything else.

- `trustedHosts(...names)` gives the hosts of services — forges (`github`, `gitlab`, `bitbucket`, `codeberg`), package registries and toolchains (`npm`, `yarn`, `jsr`, `deno`, `pypi`, `uv`, `conda`, `crates`, `rustup`, `go`, `maven`, `gradle`, `rubygems`, `packagist`, `nuget`, `pub`, `hex`…), infrastructure (`terraform`, `helm`, `kubernetes`), container registries (`docker-hub`, `ghcr`, `quay`, `mcr`, `gcr`) and Linux archives (`debian`, `ubuntu`, `alpine`) — or of groups of them (`'javascript'`, `'python'`, `'containers'`…), every service without any (`TRUSTED_HOSTS`, `TRUSTED_GROUPS`).
- `harnessHosts(harness.harnessId, options?)` gives where each `@ai-sdk/harness-*` runtime installs from, its own service and its provider's API (`HARNESS_NETWORK`); `provider` takes another provider, `optional` adds telemetry and the like.
- `providerHosts(provider, { region, resource })` gives the API hosts of the model providers of the AI SDK, Vertex AI, Bedrock and Azure by region or resource (`PROVIDER_HOSTS`).
- `networkPolicy(...lists)` checks and merges them, with those of a workspace and of plugins, into `{ mode: 'custom', allowedHosts }`. `isAllowedHost()` and `InvalidHostError` refuse what a network policy cannot take: a scheme, a path, a port, `*` or `*.com`.
