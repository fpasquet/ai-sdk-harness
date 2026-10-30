---
'ai-sdk-sandbox-gce': patch
---

The client deletes a template's throwaway sandbox once the sandbox made from the template runs, rather than as soon as the template is saved. With `SANDBOX_PROXY_INSTANCE`, no sandbox ran in between: the service stopped the egress proxy, and the sandbox that followed waited a whole minute for it to boot again.
