---
'ai-sdk-harness-workspace': patch
---

A repository of `repositories` can be `primary`, checked out in the session's working directory itself, and the others mounted at an absolute path of the sandbox with `mountAt`, in place of the directory of their key: the paths the same repositories have on the developer's machine, for instance. `session.additionalDirectories()` lists the checkouts outside the working directory, every repository's but the primary one, for the runtime to be told it may work there too (Claude Code's `--add-dir`). A repository mounted elsewhere keeps its key as its name, and its files are under it in the session's changes.
