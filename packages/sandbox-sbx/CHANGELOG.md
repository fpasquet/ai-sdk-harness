# ai-sdk-sandbox-sbx

## 0.2.3

### Patch Changes

- b892885: A failed `setup` command is named in the error, `Setup command \`…\` exited with <code>: <stderr>`, as the Compute Engine, Cloud Run and microsandbox sandboxes name it, rather than `` `sbx exec`exited with <code> ``: the caller can tell which of its commands failed, a template's setup included. The error is still an`SbxError`, with the same `args`, `exitCode`and`stderr`.

## 0.2.2

### Patch Changes

- 6f37b21: Follow the `spawn()` of `@ai-sdk/provider-utils` 5.0.70, which a sandbox session had to implement to type-check with it. `spawn({ command, stdin: true })` hands back a process with a writable `stdin`, whose close is the end of the command's input, in a Docker Sandbox, a microsandbox and an srt sandbox; without `stdin`, standard input stays closed and the process has no `stdin`. A Cloud Run or Compute Engine sandbox refuses `stdin: true` before the command starts, as the contract asks of a sandbox without it: their service carries no input to a process yet.

## 0.2.1

### Patch Changes

- b525e3b: Build a `template` under the network of the sandbox it is for. Its `setup` and the harness's install used to run in a builder sandbox with the machine's whole network, whatever `networkPolicy`, `denyNetwork` or `allowNetwork` said; they now run under them, as they would in the sandbox. When the build fails, the error names the hosts the network refused to it. Templates built before are built again once.

## 0.2.0

### Minor Changes

- 9d4b0ad: A new sandbox is checked for what a harness needs, once its `setup` ran: Node.js for the harness's bridge and git for the repositories, whatever the project's language. An image lacking one fails the creation with `SbxSandboxImageError`, which names what is missing, the sandbox removed, rather than the harness failing in the middle of its bootstrap. `requiredCommands` changes the list.
  
  BREAKING: a sandbox made from an image without `node` or `git` now fails its creation. Pass `requiredCommands: []` for a sandbox no harness runs in.

### Patch Changes

- abcb895: `run()` and `spawn()` run their command with bash, as `@ai-sdk/sandbox-vercel` does, or with sh in an image without bash: they ran it with sh, and a harness that writes bash failed there. Pi does, from its first command: `sh: 1: Syntax error: "(" unexpected`.
- abcb895: A network policy applied again to a local sandbox, as an application that restarts does when it opens the sandbox again, no longer leaves it without its rules. `sbx` adds no rule for a host and protocol it already has one for, and the previous rules were then removed with the new ones: the sandbox fell back to the default deny, every host waiting for an approval. The rules the new policy holds too are now kept.

## 0.1.4

### Patch Changes

- 01d7c18: `blockedRequests({ since?, abortSignal? })` on a local `SbxNetworkSandboxSession` lists the hosts the Docker Sandboxes proxy refused to the sandbox, the last refused first, from `sbx policy log`: the host, the port, the proxy's reason, how many requests it refused and when it first and last did. An application can tell a person which host its network policy blocked, and let them allow it. The log is kept by sandbox name and outlives the sandbox: pass `since` to leave older refusals out. Absent on a cloud sandbox, like `setNetworkPolicy`.
- 9924529: A listing of `sbx` (`ls`, `template ls`, `policy ls`, `secret ls`) that does not answer within `commandTimeoutMs`, or that `sbx` refuses because the Docker sign-in service is unavailable, is tried twice more, 2 then 5 seconds later. A `sandboxd` that cannot refresh its Docker session for a moment no longer fails the creation or the resumption of a sandbox.

## 0.1.3

### Patch Changes

- 27c77d1: Works with `sbx` 0.48: creating a sandbox no longer passes `--quiet`, which 0.48 refuses, and template images are read from the listing whether `sbx` returns them as an array, as 0.48 does, or under `images`, as earlier versions do.
- 2d6e2e2: A control command of `sbx` that hangs no longer holds the caller: listing, publishing a port, stopping or removing the sandbox and the package's own short commands in it are stopped after `commandTimeoutMs` (60 seconds by default) and fail with `SbxTimeoutError`. Creating the sandbox, its `setup`, file reads and writes and the agent's commands have no deadline, as before.
  
  A signed-out `sbx`, or one whose Docker sign-in expired, now fails with `SbxNotSignedInError`, which says to run `sbx login`; for 30 seconds after, the other commands of the same sandbox fail with it at once instead of running `sbx` again, so a cleanup after the failure no longer waits for minutes.

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
