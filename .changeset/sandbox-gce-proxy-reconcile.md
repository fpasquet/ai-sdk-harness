---
'ai-sdk-sandbox-gce': minor
---

The service makes the egress proxy forget the sandboxes whose machine no longer runs. A machine stopped or deleted outside the service, a Spot machine taken back, one stopped at `SANDBOX_MAX_RUN_HOURS` or from the console, left its credentials in the proxy's memory until the application stopped the sandbox or the proxy restarted. In the background of a creation or a resume, every `SANDBOX_RECONCILE_MINUTES` at most (10 by default, `0` for never), the service now compares what the proxy holds with the machines of the zone, and forgets each sandbox whose address no running machine holds, or another sandbox of the service holds now. A sandbox registered again meanwhile is kept, and so is one of another service sharing the proxy in the zone. The proxy lists its sandboxes at `GET /v1/sandboxes`, and `DELETE /v1/sandboxes/:name?serial=` only forgets the registration it listed; a proxy of an earlier version is left as it is: upgrade it with the service.
