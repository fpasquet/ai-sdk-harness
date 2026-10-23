---
'ai-sdk-harness-workspace': patch
---

`workspace.hosts()` names the hosts the sandbox fetches the workspace's repositories from, for the `allowedHosts` of a sandbox whose network policy is closed: `['github.com']` for a `gitRepository()` of GitHub, none for `hostRepository()` and `sandboxRepository()`. With repositories chosen per session, `hosts({ sessionId })` gives those of a session. Each source says it too, in its `hosts`. A host is a hostname, without scheme, path or port: a network policy allows a host on every port.
