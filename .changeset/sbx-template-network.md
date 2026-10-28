---
'ai-sdk-sandbox-sbx': patch
---

Build a `template` under the network of the sandbox it is for. Its `setup` and the harness's install used to run in a builder sandbox with the machine's whole network, whatever `networkPolicy`, `denyNetwork` or `allowNetwork` said; they now run under them, as they would in the sandbox. When the build fails, the error names the hosts the network refused to it. Templates built before are built again once.
