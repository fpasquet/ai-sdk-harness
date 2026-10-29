---
'ai-sdk-sandbox-gce': minor
---

BREAKING: on Cloud Run, the sandbox service refuses to start without `SANDBOX_SERVICE_TOKEN`. The token is the second lock beside Cloud Run's IAM: without it, a service deployed with `--allow-unauthenticated` by mistake would let anyone run commands in every sandbox. Set `SANDBOX_INSECURE_NO_TOKEN=true` to keep a service without a token; it then logs a warning at startup. Off Cloud Run, the token stays optional.

The service also logs a warning at startup when `SANDBOX_ALLOWED_HOSTS` holds `*`: every sandbox may then reach any host over HTTPS, and send its files there.
