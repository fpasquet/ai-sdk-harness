# ai-sdk-sandbox-sbx

## 0.1.2

### Patch Changes

- 75fdf26: A local sandbox takes a harness `networkPolicy` at creation, and `setNetworkPolicy()` replaces it while it runs: rules of the Docker Sandboxes policy scoped to the sandbox, on top of the machine's. `custom` allows the listed hosts and blocks only, denying what the machine allows besides; `deny-all` denies every host; `allow-all` is the machine's policy as it is, which keeps private networks and the metadata server out of reach. The README warns about the files an agent writes in a read-write `workspace`, and links the upstream issues behind the remaining limits.

## 0.1.1

### Patch Changes

- d1ae211: `fork({ ports })` gives another view of the same sandbox, with ports of its own, so several harness sessions, each with its bridge on its own port, run side by side in one sandbox. A view starts its own processes and registers its own credentials, and its `release()` only touches what is its own: releasing one session leaves the others running. `stop()` and `destroy()` still act on the whole sandbox.

## 0.1.0

### Minor Changes

- dc8b966: First release: run AI SDK harness agents (Claude Code, Codex…) in a [Docker Sandbox](https://docs.docker.com/ai/sandboxes/) microVM through the `sbx` CLI. `createSbxNetworkSandboxSession()` creates a sandbox, optionally from a template image baked once by `agent.getSandboxTemplate()`, and `resumeSbxNetworkSandboxSession()` reattaches to it. Ports are published on demand, on the host loopback only, and credentials stay outside the sandbox: the Docker Sandboxes proxy puts them in the requests on the way out.
  
  Docker Sandboxes Cloud is supported with `cloud: true`, as an experimental feature.
