---
'ai-sdk-sandbox-sbx': patch
---

A listing of `sbx` (`ls`, `template ls`, `policy ls`, `secret ls`) that does not answer within `commandTimeoutMs`, or that `sbx` refuses because the Docker sign-in service is unavailable, is tried twice more, 2 then 5 seconds later. A `sandboxd` that cannot refresh its Docker session for a moment no longer fails the creation or the resumption of a sandbox.
