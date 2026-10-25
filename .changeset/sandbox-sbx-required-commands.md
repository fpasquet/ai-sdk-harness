---
'ai-sdk-sandbox-sbx': minor
---

A new sandbox is checked for what a harness needs, once its `setup` ran: Node.js for the harness's bridge and git for the repositories, whatever the project's language. An image lacking one fails the creation with `SbxSandboxImageError`, which names what is missing, the sandbox removed, rather than the harness failing in the middle of its bootstrap. `requiredCommands` changes the list.

BREAKING: a sandbox made from an image without `node` or `git` now fails its creation. Pass `requiredCommands: []` for a sandbox no harness runs in.
