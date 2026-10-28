# ai-sdk-sandbox-gce

## 0.2.0

### Minor Changes

- 4b95a30: `spawn({ command, stdin: true })` hands back a process with a writable `stdin` in a Cloud Run or a Compute Engine sandbox too, whose close is the end of the command's input. Each write reaches the service in a request of its own: what is written meanwhile leaves with the next one, and a request that fails on the way is sent again, the service writing nothing twice.
  
  BREAKING: the client and the service speak version 2 of their protocol, which a service of an earlier version refuses. Deploy the sandbox service with this version of the package; for Compute Engine, build the sandbox image and the proxy's again with it too.

## 0.1.1

### Patch Changes

- 6f37b21: Follow the `spawn()` of `@ai-sdk/provider-utils` 5.0.70, which a sandbox session had to implement to type-check with it. `spawn({ command, stdin: true })` hands back a process with a writable `stdin`, whose close is the end of the command's input, in a Docker Sandbox, a microsandbox and an srt sandbox; without `stdin`, standard input stays closed and the process has no `stdin`. A Cloud Run or Compute Engine sandbox refuses `stdin: true` before the command starts, as the contract asks of a sandbox without it: their service carries no input to a process yet.

## 0.1.0

### Minor Changes

- First release: Compute Engine sandboxes for AI SDK harness agents. Each sandbox is a virtual machine of its own, Docker and Docker Compose included, with no external address, no service account and no way out but an egress proxy that keeps the credentials outside. `createGceNetworkSandboxSession()` and `resumeGceNetworkSandboxSession()` speak the protocol of `ai-sdk-sandbox-cloud-run` to a sandbox service you deploy on Cloud Run (`ai-sdk-sandbox-gce serve`), which drives the machines; the package also ships the egress proxy (`ai-sdk-sandbox-gce proxy`) and the agent of the sandbox image (`ai-sdk-sandbox-gce agent`). `stop()` stops the machine and keeps its disk, and `stop()` and `destroy()` return within seconds, Compute Engine finishing on its own; templates are saved as images. Spot machines (`SANDBOX_SPOT`) are created or started as standard ones when the zone has no Spot capacity left, unless `SANDBOX_SPOT_FALLBACK=false`. `SANDBOX_MAX_RUNNING` caps the sandboxes running at once. `SANDBOX_MAX_RUN_HOURS` has Compute Engine stop a machine after so long, and `SANDBOX_PROXY_INSTANCE` lets the service start the egress proxy with the first sandbox and stop it with the last. Each sandbox picks its image among those the service offers (`image`, `SANDBOX_IMAGES`), one per toolchain say, and an image lacking Node.js or git, which every harness needs, fails the creation with `GceSandboxImageError`.
