---
'ai-sdk-sandbox-cloud-run': patch
---

The sandbox service's image is published to Docker Hub with each release, `docker.io/fpasquet/ai-sdk-sandbox-cloud-run:<version>`, with a provenance attestation: Node.js, git, `pnpm`, `curl`, `python3`, `ripgrep` and the package. Deploy it with `gcloud beta run deploy --image` when your agents need nothing more, or start your own image `FROM` it to add a toolchain. The README deploys it so, and no longer asks twice for Cloud Build's account.
