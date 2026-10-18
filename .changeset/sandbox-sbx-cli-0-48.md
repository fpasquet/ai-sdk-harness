---
'ai-sdk-sandbox-sbx': patch
---

Works with `sbx` 0.48: creating a sandbox no longer passes `--quiet`, which 0.48 refuses, and template images are read from the listing whether `sbx` returns them as an array, as 0.48 does, or under `images`, as earlier versions do.
