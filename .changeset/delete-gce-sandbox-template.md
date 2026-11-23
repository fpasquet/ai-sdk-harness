---
'ai-sdk-sandbox-gce': patch
---

`deleteGceSandboxTemplate()` deletes the template that sandboxes created with a given `template`, `setup` and `image` boot from. A template made for a `setup` of its own, one per project say, used to outlive that setup when it changed or went, its image billed for its storage until deleted by hand. The sandboxes made from it keep their disk; the next sandbox created from the same template builds it again, without first meeting a 404 in the process that deleted it. A template that does not exist is no error.
