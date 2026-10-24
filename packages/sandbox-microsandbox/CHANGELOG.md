# ai-sdk-sandbox-microsandbox

## 0.1.1

### Patch Changes

- abcb895: `run()` and `spawn()` run their command with bash, as `@ai-sdk/sandbox-vercel` does, or with sh in an image without bash: they ran it with sh, and a harness that writes bash failed there. Pi does, from its first command: `sh: 1: Syntax error: "(" unexpected`.

## 0.1.0

### Minor Changes

- 5a8dac8: First release: run AI SDK harness agents (Claude Code, Codex…) in a [microsandbox](https://github.com/superradcompany/microsandbox), a microVM with a Linux kernel of its own, booted from any OCI image on your machine through the `microsandbox` SDK, which ships the runtime. `createMicrosandboxNetworkSandboxSession()` creates a sandbox from `node:24`, or the `image` you name, optionally restored from a template saved once as a disk snapshot by `agent.getSandboxTemplate()`; `resumeMicrosandboxNetworkSandboxSession()` reattaches to it, starting it again if it was stopped. Commands run as an unprivileged user (`node` in the default image), `setup` as `root`.
  
  Credentials never enter the sandbox: the harness only hands it placeholders, and each request transformation becomes a microsandbox secret, allowed for the API's host only, which microsandbox's network stack puts in the HTTPS requests on their way out. microsandbox stores the real value in its database on the host until the secret is withdrawn. Ports are published on the loopback when the sandbox is created, and a harness network policy (`allow-all`, `deny-all` or a list of hosts and blocks) can restrict what the sandbox reaches; `allow-all` means the public internet, never this host or its private networks.
  
  The sandbox is hardened by default: its commands run under microsandbox's `restricted` profile (no setuid way to root), it holds 1024 connections at most, and host directories are mounted `nosuid,nodev`. `readOnlyWorkspaces` mounts more host directories read-only, `security: 'default'` keeps root semantics, and `maxDuration` and `idleTimeout` stop the sandbox after a while.
  
  `docker: true` runs a Docker daemon in the sandbox, for `docker` and `docker compose`: installed once with Docker's own script and kept in the template, its data on a disk of its own, started again whenever the sandbox starts, its socket owned by the sandbox's user, and Docker Hub reachable under a `custom` network policy.
  
  `pruneMicrosandboxTemplates()` removes the template snapshots a harness upgrade leaves behind, or only those older than `olderThan`.
