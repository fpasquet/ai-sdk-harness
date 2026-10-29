---
'ai-sdk-sandbox-gce': patch
---

The egress proxy counts the bytes each sandbox sends out and receives, over every connection of its machine, refused ones included. It logs them when it forgets the sandbox (`box forgotten, having sent 12.3 MB out and received 450.0 MB`) and gives them, `sent` and `received`, for each sandbox at `GET /v1/sandboxes`. An allowed host is a way out for data: the count shows a sandbox that sent out far more than its task needs.
