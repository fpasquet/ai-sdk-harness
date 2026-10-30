---
'ai-sdk-sandbox-cloud-run': minor
---

On Cloud Run, the sandbox service refuses to start without `SANDBOX_SERVICE_TOKEN`, as the Compute Engine one does since 0.3.0. The token was optional: a service deployed open by mistake let anyone who reached it run commands in every sandbox. `SANDBOX_INSECURE_NO_TOKEN=true` runs without it, Cloud Run's IAM then the only lock, and logs a warning at startup. The README's deployment now creates the token and sets it.

BREAKING: a service on Cloud Run without `SANDBOX_SERVICE_TOKEN` no longer starts. Set the token, and hand it to the client as `serviceToken`, or set `SANDBOX_INSECURE_NO_TOKEN=true`.
