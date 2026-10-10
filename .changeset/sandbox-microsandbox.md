---
'ai-sdk-sandbox-microsandbox': minor
---

First release: run AI SDK harness agents (Claude Code, Codex…) in a [microsandbox](https://github.com/superradcompany/microsandbox), a microVM with a Linux kernel of its own, booted from any OCI image on your machine through the `microsandbox` SDK, which ships the runtime. `createMicrosandboxNetworkSandboxSession()` creates a sandbox from `node:24`, or the `image` you name, optionally restored from a template saved once as a disk snapshot by `agent.getSandboxTemplate()`; `resumeMicrosandboxNetworkSandboxSession()` reattaches to it, starting it again if it was stopped. Commands run as an unprivileged user (`node` in the default image), `setup` as `root`.

Credentials never enter the sandbox: the harness only hands it placeholders, and each request transformation becomes a microsandbox secret, allowed for the API's host only, which microsandbox's network stack puts in the HTTPS requests on their way out. microsandbox stores the real value in its database on the host until the secret is withdrawn. Ports are published on the loopback when the sandbox is created, and a harness network policy (`allow-all`, `deny-all` or a list of hosts and blocks) can restrict what the sandbox reaches.
