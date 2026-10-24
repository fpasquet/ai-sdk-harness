---
'ai-sdk-sandbox-microsandbox': patch
---

`run()` and `spawn()` run their command with bash, as `@ai-sdk/sandbox-vercel` does, or with sh in an image without bash: they ran it with sh, and a harness that writes bash failed there. Pi does, from its first command: `sh: 1: Syntax error: "(" unexpected`.
