---
'ai-sdk-sandbox-gce': patch
---

A command whose machine's agent stops before it exits (the agent restarted or killed, the machine stopping) no longer leaves the caller waiting until its own timeout: the service cuts its streamed answer at once, and the session, its exit code never coming, asks for the process by id, then reports it as killed (exit code 137). The service's answer used to stay open, a `run` or a `wait()` blocked for as long as the request could last.
