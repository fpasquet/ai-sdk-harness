---
'ai-sdk-sandbox-gce': patch
---

The agent of a sandbox gets a new token at each `stop()`. The token was derived from `SANDBOX_AGENT_SECRET` and the machine's name alone, so it stayed the same for the whole life of the sandbox, and for a sandbox deleted and made again under the same name. It now also covers a run drawn at random when the machine is made and each time the service stops it, kept beside the token in the instance metadata: a token read there once, by anyone allowed to read the project's machines, serves until the next stop. The agent reads its token as the machine boots, as before, so the sandbox image needs no rebuild. A machine made before keeps its token until its next stop. Stopping needs `compute.instances.setMetadata`, already in the service's role: without it, the machine keeps its token and the stop goes on, with a warning.
