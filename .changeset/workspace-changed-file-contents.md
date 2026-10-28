---
'ai-sdk-harness-workspace': patch
---

`changedFiles()` gives each file its Git `mode` — `100644`, `100755` for an executable, `120000` for a symbolic link, `160000` for a submodule — and, with `{ contents: true }`, its `content`: the bytes the repository would hold once the change is committed, read from the blobs Git staged. Enough to publish an agent's work through a forge's API, blobs, a tree and a commit, without a clone nor a push from the sandbox.
