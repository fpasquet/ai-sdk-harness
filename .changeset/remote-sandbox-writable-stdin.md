---
'ai-sdk-sandbox-cloud-run': minor
'ai-sdk-sandbox-gce': minor
---

`spawn({ command, stdin: true })` hands back a process with a writable `stdin` in a Cloud Run or a Compute Engine sandbox too, whose close is the end of the command's input. Each write reaches the service in a request of its own: what is written meanwhile leaves with the next one, and a request that fails on the way is sent again, the service writing nothing twice.

BREAKING: the client and the service speak version 2 of their protocol, which a service of an earlier version refuses. Deploy the sandbox service with this version of the package; for Compute Engine, build the sandbox image and the proxy's again with it too.
