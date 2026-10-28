---
'ai-sdk-sandbox-gce': patch
---

Git over HTTPS takes the credentials brokered for its server, such as a repository of `ai-sdk-harness-workspace`. Its requests went through the proxy's TLS tunnel, which the proxy cannot read, so the server got the placeholder and refused the fetch. The agent now sends them to the proxy's routes, through a `url.<proxy>/https/.insteadOf https://` setting added after the command's own `GIT_CONFIG_*` entries. Build the sandbox image again with this version.
