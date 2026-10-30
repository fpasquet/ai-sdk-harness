---
'ai-sdk-sandbox-gce': patch
---

The sandbox service's image is published to Docker Hub with each release, `docker.io/fpasquet/ai-sdk-sandbox-gce:<version>`, with a provenance attestation: deploy it with `gcloud run deploy --image`, rather than writing a `Dockerfile` and having Cloud Build make it with an account of its own. The README deploys it so.
