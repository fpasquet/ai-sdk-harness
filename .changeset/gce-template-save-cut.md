---
'ai-sdk-sandbox-gce': patch
---

A template whose image takes more than five minutes to save is no longer lost. Node.js's fetch gave up on the save call after five minutes, so the client removed the builder while Compute Engine was still making the image from its disk, and the session failed with `fetch failed`. When the call is cut on the way, by the network or by Cloud Run's front end, the client now asks the service for the template until it is ready, for up to 30 minutes, and removes the builder only after that. A refusal from the service is still reported at once.
