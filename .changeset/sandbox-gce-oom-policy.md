---
'ai-sdk-sandbox-gce': patch
---

A command that runs out of memory in a Compute Engine sandbox no longer kills every other command of the sandbox. The commands run in the agent's systemd service, and systemd stops a service whose process the kernel's OOM killer killed: the other commands, a harness bridge included, exited with 143 (`SIGTERM`), and the agent restarted. The agent now sets `OOMPolicy=continue` on its service as it starts, whatever unit the image has: only the command killed goes, with 137.

Rebuild the sandbox image with this version (`npm install --global ai-sdk-sandbox-gce@<version>`): the agent runs from the image, and the templates are made again on the new image. The README's unit has the line too.
