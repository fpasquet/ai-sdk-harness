---
'ai-sdk-sandbox-gce': minor
---

The agent of each machine samples it every 30 s from `/proc` (CPU busy and stolen shares, memory in use, CPU and memory pressure, OOM kills), keeping the last day of samples on the machine's disk, across stops. `metrics()` of a session, or `getGceSandboxMetrics({ since })`, reads them while the sandbox runs (`GET /v1/sandboxes/:name/metrics?since=` on the service, `GET /v1/metrics` on the agent), and a stop or a deletion reads the last ones before the machine goes, in the `metrics` of its report. Read in the machine, they are fit for sizing, never for billing. `SANDBOX_METRICS_INTERVAL` sets the interval on the agent. Build the sandbox image again with this version to get them: an earlier agent samples nothing.
