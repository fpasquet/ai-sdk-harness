---
'ai-sdk-harness-workspace': patch
---

`repositories` can be a function of the session: `createWorkspace({ repositories: ({ sessionId }) => … })` gives each session its own repositories — a project each, say — so that one workspace, one session manager and one store serve them all. It is called when a session starts, resumes or is closed, and may look the repositories up in your database.
