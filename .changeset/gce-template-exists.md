---
'ai-sdk-sandbox-gce': minor
---

`gceSandboxTemplateExists({ template, setup, image })` says whether the template that sandboxes created with these options boot from is saved on the service. It is not after a new base image, a new version of the service or a new harness version, which each name another template: an application can build it ahead rather than have the next sandbox build it.
