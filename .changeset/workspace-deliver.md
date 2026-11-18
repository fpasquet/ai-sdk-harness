---
'ai-sdk-harness-workspace': patch
---

`deliver({ to, branch, commitMessage })`, of a session or of one of its checkouts, brings the commit a checkout is at back into a repository on this host, on a branch, in place of a patch: a Git bundle written in the sandbox, fetched here with no hook of the repository. The branch checked out on this host, and one that went its own way, are never moved: the delivery takes the next free name, `<branch>-2`, and says which. `commitMessage` commits what the agent left uncommitted first.
