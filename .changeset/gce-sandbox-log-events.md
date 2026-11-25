---
'ai-sdk-sandbox-gce': minor
---

The service logs each creation, resume, suspension and deletion as a structured JSON line, `{ event, sandbox, at, … }`, beside its message: the machine, the image, the template, the caller's labels and the timings of a creation; the timings of a resume; the proxy's last count of a suspension or a deletion. Cloud Logging reads them as structured entries, for log-based metrics. With `LOG_FORMAT=text`, the message alone is written, as before.
