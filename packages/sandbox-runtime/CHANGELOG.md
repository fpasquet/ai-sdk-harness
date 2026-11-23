# ai-sdk-sandbox-runtime

## 0.1.3

### Patch Changes

- c89c8ef: Sessions implement `stat`, `listDirectory` and `deleteFile`, which `SandboxSession` requires since `@ai-sdk/provider-utils` 5.0.81. `stat` follows symbolic links and answers `null` for a path that does not exist; `listDirectory` reports a link as `symlink` without following it, answers `null` for a missing directory and rejects with `ENOTDIR` for a file; `deleteFile` deletes a link rather than its target, answers `false` for a missing file and rejects with `EISDIR` for a directory.

## 0.1.2

### Patch Changes

- 6f37b21: Follow the `spawn()` of `@ai-sdk/provider-utils` 5.0.70, which a sandbox session had to implement to type-check with it. `spawn({ command, stdin: true })` hands back a process with a writable `stdin`, whose close is the end of the command's input, in a Docker Sandbox, a microsandbox and an srt sandbox; without `stdin`, standard input stays closed and the process has no `stdin`. A Cloud Run or Compute Engine sandbox refuses `stdin: true` before the command starts, as the contract asks of a sandbox without it: their service carries no input to a process yet.

## 0.1.1

### Patch Changes

- abcb895: `run()` and `spawn()` run their command with bash, as `@ai-sdk/sandbox-vercel` does, or with sh in an image without bash: they ran it with sh, and a harness that writes bash failed there. Pi does, from its first command: `sh: 1: Syntax error: "(" unexpected`.
- abcb895: A Next.js application built with Turbopack no longer warns about `ai-sdk-sandbox-runtime`. Next.js bundles a workspace dependency even when `serverExternalPackages` lists it, and Turbopack then reported that it could not resolve the package names this one finds at run time, and that copying the supervisor and starting srt would trace the whole project into the server output. These three calls now carry a `turbopackIgnore` comment; what they do is unchanged.

## 0.1.0

### Minor Changes

- c894e90: First release: Anthropic Sandbox Runtime (srt) sandbox sessions for `HarnessAgent`, on this host. `createSrtNetworkSandboxSession()` / `resumeSrtNetworkSandboxSession()` run each sandbox as one supervisor srt wraps, under bubblewrap (Linux) or `sandbox-exec` (macOS): the user's home hidden, writes kept to the sandbox's own directory and its workspace, only the allowed hosts reachable, credentials put in by srt's proxy, the bridge's port forwarded to the host's loopback. `fork()` and `release()` share one sandbox between harness sessions. The sockets that drive the host — the session and system D-Bus, and the Docker, containerd and Podman sockets — are kept out of every sandbox whether or not srt's seccomp filter runs. Where srt 0.0.79 keeps one network allow list per process, a second sandbox whose hosts differ is refused rather than sharing the union.
