---
'ai-sdk-sandbox-runtime': minor
---

First release: Anthropic Sandbox Runtime (srt) sandbox sessions for `HarnessAgent`, on this host. `createSrtNetworkSandboxSession()` / `resumeSrtNetworkSandboxSession()` run each sandbox as one supervisor srt wraps, under bubblewrap (Linux) or `sandbox-exec` (macOS): the user's home hidden, writes kept to the sandbox's own directory and its workspace, only the allowed hosts reachable, credentials put in by srt's proxy, the bridge's port forwarded to the host's loopback. `fork()` and `release()` share one sandbox between harness sessions.
