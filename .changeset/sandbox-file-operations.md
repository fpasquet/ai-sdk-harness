---
'ai-sdk-sandbox-sbx': patch
'ai-sdk-sandbox-microsandbox': patch
'ai-sdk-sandbox-runtime': patch
'ai-sdk-sandbox-cloud-run': patch
'ai-sdk-sandbox-gce': patch
---

Sessions implement `stat`, `listDirectory` and `deleteFile`, which `SandboxSession` requires since `@ai-sdk/provider-utils` 5.0.81. `stat` follows symbolic links and answers `null` for a path that does not exist; `listDirectory` reports a link as `symlink` without following it, answers `null` for a missing directory and rejects with `ENOTDIR` for a file; `deleteFile` deletes a link rather than its target, answers `false` for a missing file and rejects with `EISDIR` for a directory.
