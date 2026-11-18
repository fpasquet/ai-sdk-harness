---
'ai-sdk-harness-approval': patch
---

`remoteApprover({ request, timeoutMs })` answers approvals from a remote interface — a page of its own, a phone — while the turn waits: `request` asks the interface and resolves with its answer, and every step is a plain JSON event (`requested`, `answered`, `abandoned`) for each interface to follow, through `subscribe()` or `onEvent`, with `pending()` for one that connects. An approval is abandoned by `abandon(approvalId)`, the `abortSignal` of the context it is asked with, `timeoutMs`, or a `request` that resolves without an answer; the signal `request` holds aborts then. Its `approve` is the `approve` option of `createSessionManager()`, after a policy's.
