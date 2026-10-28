# ai-sdk-sandbox-cloud-run

## 0.1.5

### Patch Changes

- 6f37b21: Follow the `spawn()` of `@ai-sdk/provider-utils` 5.0.70, which a sandbox session had to implement to type-check with it. `spawn({ command, stdin: true })` hands back a process with a writable `stdin`, whose close is the end of the command's input, in a Docker Sandbox, a microsandbox and an srt sandbox; without `stdin`, standard input stays closed and the process has no `stdin`. A Cloud Run or Compute Engine sandbox refuses `stdin: true` before the command starts, as the contract asks of a sandbox without it: their service carries no input to a process yet.

## 0.1.4

### Patch Changes

- 6cba27c: The README says what the service's image needs whatever the project's language, Node.js and git beside its toolchain, and that every sandbox of a service shares it.

## 0.1.3

### Patch Changes

- abcb895: `run()` and `spawn()` run their command with bash, as `@ai-sdk/sandbox-vercel` does, or with sh in an image without bash: they ran it with sh, and a harness that writes bash failed there. Pi does, from its first command: `sh: 1: Syntax error: "(" unexpected`.

## 0.1.2

### Patch Changes

- 4c79fd3: The egress proxy takes the credentials it puts in a request out of the response headers, so an API echoing them back never hands them to the sandbox, and refuses the NAT64 and 6to4 IPv6 addresses that carry a private IPv4 one, the metadata server's included. The service warns when it starts with `SANDBOX_ALLOW_EGRESS`, whose network bypasses the proxy.

## 0.1.1

### Patch Changes

- d1ae211: `fork({ ports })` gives another view of the same sandbox, with ports of its own, so several harness sessions, each with its bridge on its own port, run side by side in one sandbox. A view starts its own processes and registers its own credentials, and its `release()` only touches what is its own: releasing one session leaves the others running. `stop()` and `destroy()` still act on the whole sandbox.

## 0.1.0

### Minor Changes

- ab672f3: First release: run AI SDK harness agents (Claude Code, Codex…) in [Cloud Run sandboxes](https://docs.cloud.google.com/run/docs/code-execution) on Google Cloud. The package ships the sandbox service, `ai-sdk-sandbox-cloud-run serve`, to deploy in a Cloud Run service with `--sandbox-launcher`, and its client: `createCloudRunNetworkSandboxSession()` creates a sandbox, optionally from a template saved once by `agent.getSandboxTemplate()`, and `resumeCloudRunNetworkSandboxSession()` reattaches to it. `stop()` suspends a sandbox to a snapshot on Cloud Storage, so nothing runs between turns.
  
  Credentials never enter the sandbox nor any log: the harness only hands it placeholders, the service puts the real values in the requests on their way out, over HTTPS only, and refuses any command that would carry one in; commands, their variables and their directory reach the sandbox on a launcher's standard input, so Cloud Run's logs only show the launcher. The sandboxes have no network but an egress proxy, which allows listed hosts and never a private address, the metadata server included. Calls go through Cloud Run's IAM, and may carry a shared service token on top.
