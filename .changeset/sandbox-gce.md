---
'ai-sdk-sandbox-gce': minor
---

First release: Compute Engine sandboxes for AI SDK harness agents. Each sandbox is a virtual machine of its own, Docker and Docker Compose included, with no external address, no service account and no way out but an egress proxy that keeps the credentials outside. `createGceNetworkSandboxSession()` and `resumeGceNetworkSandboxSession()` speak the protocol of `ai-sdk-sandbox-cloud-run` to a sandbox service you deploy on Cloud Run (`ai-sdk-sandbox-gce serve`), which drives the machines; the package also ships the egress proxy (`ai-sdk-sandbox-gce proxy`) and the agent of the sandbox image (`ai-sdk-sandbox-gce agent`). `stop()` stops the machine and keeps its disk; templates are saved as images. Each sandbox picks its image among those the service offers (`image`, `SANDBOX_IMAGES`), one per toolchain say, and an image lacking Node.js or git, which every harness needs, fails the creation with `GceSandboxImageError`.
