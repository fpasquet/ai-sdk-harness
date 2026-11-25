---
'ai-sdk-sandbox-gce': patch
---

The service's Docker image is now based on Debian 13 (`node:24-trixie-slim`) and no longer contains npm, corepack or yarn: the service only runs Node.js. An image of your own built `FROM` it that calls npm must install it.
