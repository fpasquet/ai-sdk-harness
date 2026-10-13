---
'ai-sdk-sandbox-runtime': minor
---

First release: Anthropic Sandbox Runtime (srt) sandbox sessions for `HarnessAgent`, on this host. `createSrtNetworkSandboxSession()` / `resumeSrtNetworkSandboxSession()` run each sandbox as one supervisor srt wraps, under bubblewrap (Linux) or `sandbox-exec` (macOS): the user's home hidden, writes kept to the sandbox's own directory and its workspace, only the allowed hosts reachable, credentials put in by srt's proxy, the bridge's port forwarded to the host's loopback. `fork()` and `release()` share one sandbox between harness sessions. The sockets that drive the host — the session and system D-Bus, and the Docker, containerd and Podman sockets — are kept out of every sandbox whether or not srt's seccomp filter runs. Where srt 0.0.79 keeps one network allow list per process, a second sandbox whose hosts differ is refused rather than sharing the union.
