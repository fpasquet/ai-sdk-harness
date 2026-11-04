---
'ai-sdk-sandbox-gce': patch
'ai-sdk-sandbox-cloud-run': patch
---

A process that outlives a template no longer fails every creation from it with a 404 until it restarts: the template is forgotten, built again, and the sandbox created. A template goes with a new version of the service, a new base image on Compute Engine, or a deletion.
