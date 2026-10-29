---
'ai-sdk-sandbox-gce': patch
---

The README spells out what the security model leaves to the deployment. An allowed host is a way out for the sandbox's files: keep `*` and wildcards on shared domains out of production. The agents' tokens sit in the machines' metadata, which `roles/viewer` and `roles/compute.viewer` read. A template is only ever made from a sandbox no agent ran in. Sandbox names must be random and checked against the user on the server. A machine stopped outside the service keeps its credentials in the proxy until the application stops it. Traffic inside the VPC is plain HTTP. The proxy's startup script and the sandbox image install Node.js and the Ops Agent from their signed apt repositories rather than by piping a script into a shell.
