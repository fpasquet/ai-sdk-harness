---
'ai-sdk-sandbox-cloud-run': patch
'ai-sdk-sandbox-sbx': patch
---

Killing a process holds each process of its tree still while its children are stopped: a shell waiting for its children could exit 0 before the `TERM` reached it, and the killed process then looked like one that ended well. It now always ends with the status of a killed process.
