---
'ai-sdk-sandbox-sbx': minor
---

First release: run AI SDK harness agents (Claude Code, Codex…) in a [Docker Sandbox](https://docs.docker.com/ai/sandboxes/) microVM through the `sbx` CLI. `createSbxNetworkSandboxSession()` creates a sandbox, optionally from a template image baked once by `agent.getSandboxTemplate()`, and `resumeSbxNetworkSandboxSession()` reattaches to it. Ports are published on demand, on the host loopback only, and credentials stay outside the sandbox: the Docker Sandboxes proxy puts them in the requests on the way out.

Docker Sandboxes Cloud is supported with `cloud: true`, as an experimental feature.
