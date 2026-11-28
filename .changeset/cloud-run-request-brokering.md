---
'ai-sdk-sandbox-cloud-run': minor
---

Git over HTTPS goes through the egress relay's routes, as on `ai-sdk-sandbox-gce` (`url.<relay>/https/.insteadOf https://` for every command): a credential brokered for a Git server, such as a repository of `ai-sdk-harness-workspace`, is now swapped in, where the TLS tunnel carried the placeholder to the server. A `http.<url>.*` setting of git keyed by an `https://` URL no longer matches. The service refuses, with a 403, a request that carries a placeholder of the sandbox where none of its rules applies; a query parameter a rule names must have no other value in the request; and a transformation added again for exactly the same match replaces the one before. The session says so with `credentialBrokering: { scope: 'request' }` (`CloudRunCredentialBrokering`), which `gitRepository({ readOnlyRemote })` of `ai-sdk-harness-workspace` requires.
