---
'ai-sdk-harness-sessions': patch
---

A retried turn (`turnRetries`) now resumes a sandbox lost with its machine — a Compute Engine Spot VM preempted, a machine stopped — instead of giving up. When the harness session cannot start again in the sandbox it held, the manager hands the sandbox back, acquires it again as after a suspension (`acquire(id, { resume: true })`, which starts a stopped machine with its disk), starts the harness session there from where it stopped, and runs the turn again: the agent's uncommitted files are kept. The client is told first with a transient `data-sandbox-resume` chunk (`SANDBOX_RESUME_CHUNK`, `{ attempt }`). A sandbox that cannot be resumed leaves the session `suspended`, with the reason, as before; a turn cut short never resumes its sandbox.
