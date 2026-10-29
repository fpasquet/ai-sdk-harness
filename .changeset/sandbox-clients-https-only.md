---
'ai-sdk-sandbox-gce': patch
'ai-sdk-sandbox-cloud-run': patch
---

The client refuses a sandbox service URL in plain HTTP, but on the loopback (`localhost`, `127.0.0.1`, `[::1]`): every call carries the identity token and the service token, which a URL in `http://` would send in clear. A service on Cloud Run is always reached in HTTPS.
