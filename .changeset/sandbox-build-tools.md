---
'ai-sdk-sandbox-cloud-run': patch
'ai-sdk-sandbox-gce': patch
---

The sandbox images carry the tools an agent most often reaches for: `make`, so it can run a project's Makefile, plus `jq`, `unzip` and `xz-utils`. The Compute Engine image script in the README also installs a C/C++ compiler (`build-essential`) for the native modules of a project's dependencies; the Cloud Run image leaves it out, some 300 MB, for an image built `FROM` it to add.
