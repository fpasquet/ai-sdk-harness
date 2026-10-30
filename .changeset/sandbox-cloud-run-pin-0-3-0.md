---
'ai-sdk-sandbox-cloud-run': patch
---

The README pins `ai-sdk-sandbox-cloud-run@0.3.0` in the service's Dockerfile, rather than `0.2.0`: the service of 0.3.0 refuses to start on Cloud Run without the token the deployment creates, where 0.2.0 ran without it.
