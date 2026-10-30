---
'ai-sdk-sandbox-gce': patch
'ai-sdk-sandbox-cloud-run': patch
---

The READMEs deploy the service with a build account of its own, `--build-service-account` granted `roles/run.builder`, rather than the Compute Engine default service account, which older projects grant `roles/editor`: whatever a build ran could then reach everything in the project, the agents' tokens included. The sandbox-gce README also has the roles inherited from the folder and the organization checked, since they read the machines' metadata as well.
