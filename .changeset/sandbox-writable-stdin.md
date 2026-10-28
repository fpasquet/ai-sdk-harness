---
'ai-sdk-sandbox-sbx': patch
'ai-sdk-sandbox-microsandbox': patch
'ai-sdk-sandbox-runtime': patch
'ai-sdk-sandbox-cloud-run': patch
'ai-sdk-sandbox-gce': patch
---

Follow the `spawn()` of `@ai-sdk/provider-utils` 5.0.70, which a sandbox session had to implement to type-check with it. `spawn({ command, stdin: true })` hands back a process with a writable `stdin`, whose close is the end of the command's input, in a Docker Sandbox, a microsandbox and an srt sandbox; without `stdin`, standard input stays closed and the process has no `stdin`. A Cloud Run or Compute Engine sandbox refuses `stdin: true` before the command starts, as the contract asks of a sandbox without it: their service carries no input to a process yet.
