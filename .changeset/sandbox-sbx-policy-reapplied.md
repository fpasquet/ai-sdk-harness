---
'ai-sdk-sandbox-sbx': patch
---

A network policy applied again to a local sandbox, as an application that restarts does when it opens the sandbox again, no longer leaves it without its rules. `sbx` adds no rule for a host and protocol it already has one for, and the previous rules were then removed with the new ones: the sandbox fell back to the default deny, every host waiting for an approval. The rules the new policy holds too are now kept.
