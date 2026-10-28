---
'ai-sdk-harness-sessions': minor
---

A store shared by several managers no longer needs SQL of its own. Each lease method is now one plain read or write of a row, what any ORM does: `getOwnership`, `writeOwnership` (an insert, or an update at the version read), `renewOwnerships` and `releaseOwnership`. The manager claims a session by a compare-and-set on that row, and every session of a manager expires with its lease. The README gives the whole store for Drizzle, and the lease methods for Prisma and MikroORM.

Also new: `withEncryptedResumeState(store, cipher)` seals the resume states before the store keeps them, with `aesGcmCipher(key)` or a cipher of your own; `sessionStoreChecks()`, from `ai-sdk-harness-sessions/testing`, checks a store against the contract with any test runner; and `createMemorySessionStore({ shared: true })` lets several managers of one process share a store.

BREAKING: `claimSession`, `renewLease` and `releaseSession` are replaced by the four ownership methods, and the `SessionClaim` type is gone. A store on a database moves its owners to a table of `(session_id, owner, expires_at, version)` and drops its table of leases; the expiry is now read on the managers' clocks. `createMemorySessionStore` moves to its own entry: import it from `ai-sdk-harness-sessions/memory`.
