---
'ai-sdk-sandbox-gce': patch
---

The egress proxy keeps an idle connection open for 120 seconds rather than Node.js's 5, longer than the runtimes' clients keep theirs: Codex's keeps an idle connection for 90 seconds, and Claude Code reused one after 34. A request a runtime sent on a connection just as the proxy closed it was reset (`ECONNRESET`).
