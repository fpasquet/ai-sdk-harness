---
'ai-sdk-sandbox-gce': patch
---

The proxy's startup script in the README upgrades the package when its pinned version changes, and restarts the proxy on it: it used to install the package only on a machine that had none, so a proxy kept its first version. The README says how to hand the new script to the machine.
