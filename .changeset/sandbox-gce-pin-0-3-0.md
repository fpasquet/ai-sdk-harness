---
'ai-sdk-sandbox-gce': patch
---

The README pins `ai-sdk-sandbox-gce@0.3.0` in the service's Dockerfile, the proxy's startup script and the sandbox image, rather than `0.2.0`: the service of 0.3.0 makes the proxy forget the sandboxes whose machine no longer runs, which takes a proxy of the same version.
