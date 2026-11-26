---
'ai-sdk-sandbox-gce': patch
---

The sandbox service sends a Compute Engine call again, up to 3 times, when Compute Engine cannot be reached (a kept-alive connection closed while Cloud Run throttled the CPU), with a request id that makes a change safe to send twice; the last failure names the call and its cause instead of `fetch failed`. A sandbox created just after the last one stopped the egress proxy is registered again once the proxy is back, rather than failing with a 502 or a 500. Unexpected errors are logged with their cause.
