# ai-sdk-sandbox-cloud-run

## 0.1.1

### Patch Changes

- d1ae211: `fork({ ports })` gives another view of the same sandbox, with ports of its own, so several harness sessions, each with its bridge on its own port, run side by side in one sandbox. A view starts its own processes and registers its own credentials, and its `release()` only touches what is its own: releasing one session leaves the others running. `stop()` and `destroy()` still act on the whole sandbox.

## 0.1.0

### Minor Changes

- ab672f3: First release: run AI SDK harness agents (Claude Code, Codex…) in [Cloud Run sandboxes](https://docs.cloud.google.com/run/docs/code-execution) on Google Cloud. The package ships the sandbox service, `ai-sdk-sandbox-cloud-run serve`, to deploy in a Cloud Run service with `--sandbox-launcher`, and its client: `createCloudRunNetworkSandboxSession()` creates a sandbox, optionally from a template saved once by `agent.getSandboxTemplate()`, and `resumeCloudRunNetworkSandboxSession()` reattaches to it. `stop()` suspends a sandbox to a snapshot on Cloud Storage, so nothing runs between turns.
  
  Credentials never enter the sandbox nor any log: the harness only hands it placeholders, the service puts the real values in the requests on their way out, over HTTPS only, and refuses any command that would carry one in; commands, their variables and their directory reach the sandbox on a launcher's standard input, so Cloud Run's logs only show the launcher. The sandboxes have no network but an egress proxy, which allows listed hosts and never a private address, the metadata server included. Calls go through Cloud Run's IAM, and may carry a shared service token on top.
