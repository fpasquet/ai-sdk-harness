---
'ai-sdk-harness-sessions': patch
---

Several managers can share one store: the instances of an application behind a load balancer, scaled out, or a new version deployed beside the old one. A store that implements three more methods — `claimSession`, `renewLease` and `releaseSession`, the lease of each manager kept on the database's clock — lets each manager run the sessions it holds:

- a starting manager no longer marks `interrupted` the live sessions of the others, only those of a manager whose lease expired;
- a request for a session another manager runs fails with `SessionOwnedElsewhereError` (a `SessionConflictError`), which names that manager (`owner`, the new `managerId` option) so that the application can route the request to it;
- a suspended session is resumed by whichever manager receives its next message;
- once the lease of a manager that crashed has expired, the others mark its live sessions `interrupted`.

`leaseTtlMs` sets the lease (30 seconds by default). A store without these methods works as before, with one manager.
