---
'ai-sdk-sandbox-gce': minor
---

The egress proxy refuses, with a 403, a request through a route that carries a placeholder of the sandbox where none of its rules applies (another path, method, query or host), rather than sending it on; a query parameter a rule names must have no other value in the request; and a transformation added again for exactly the same match replaces the one before, in the proxy and in the session's view. The session says so with `credentialBrokering: { scope: 'request' }` (`GceCredentialBrokering`), which `gitRepository({ readOnlyRemote })` of `ai-sdk-harness-workspace` requires: a `git push` with the placeholder of a credential brokered to read a repository is refused.
