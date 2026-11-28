---
'ai-sdk-harness-workspace': minor
---

`gitRepository({ readOnlyRemote: true })` gives each session's checkout an `origin` remote, the repository's URL, its branches fetched with the checkout into `refs/remotes/origin/*`: the agent can `git fetch`, `git ls-remote`, `git rebase origin/main` or `git checkout -b fix origin/fix` for the whole session. It only reads. With `credentials`, the checkout's own git configuration holds a placeholder of the session, never the token, and the sandbox's brokering swaps it for the token in the requests that read the repository alone; that takes a sandbox whose brokering matches whole requests and refuses a placeholder elsewhere (`credentialBrokering.scope === 'request'`: `ai-sdk-sandbox-gce`, `ai-sdk-sandbox-cloud-run`), any other is refused before the token is handed over. The token is renewed in place every `refreshIntervalMs` (15 minutes), at each resume and with `session.refreshCredentials()`. A `WorkspaceSource` may now `connect()` a checkout.

The credential of a fetch, with or without the remote, now only goes in Git's read requests at the repository's exact path (`GET <path>/info/refs?service=git-upload-pack`, `POST <path>/git-upload-pack`, `<path>` with and without `.git`), on its hostname: `/acme/api` no longer covers `/acme/api-other`, and a sandbox that matches whole requests never puts it in a push, nor in a Git LFS request.
