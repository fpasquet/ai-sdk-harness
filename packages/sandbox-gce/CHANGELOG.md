# ai-sdk-sandbox-gce

## 0.2.2

### Patch Changes

- 40ccefb: A template whose image takes more than five minutes to save is no longer lost. Node.js's fetch gave up on the save call after five minutes, so the client removed the builder while Compute Engine was still making the image from its disk, and the session failed with `fetch failed`. When the call is cut on the way, by the network or by Cloud Run's front end, the client now asks the service for the template until it is ready, for up to 30 minutes, and removes the builder only after that. A refusal from the service is still reported at once.

## 0.2.1

### Patch Changes

- ec23275: Git over HTTPS takes the credentials brokered for its server, such as a repository of `ai-sdk-harness-workspace`. Its requests went through the proxy's TLS tunnel, which the proxy cannot read, so the server got the placeholder and refused the fetch. The agent now sends them to the proxy's routes, through a `url.<proxy>/https/.insteadOf https://` setting added after the command's own `GIT_CONFIG_*` entries. Build the sandbox image again with this version.
- bd8f6da: The proxy's startup script in the README upgrades the package when its pinned version changes, and restarts the proxy on it: it used to install the package only on a machine that had none, so a proxy kept its first version. The README says how to hand the new script to the machine.

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
