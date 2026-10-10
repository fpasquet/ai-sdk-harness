---
'ai-sdk-harness-sessions': minor
---

The `approve` option answers the approvals a turn asks for before anyone sees them — an approval policy, the grants of the session: a verdict is sent at once and the turn goes on in the same stream, the client seeing the answer; `undefined` leaves the approval to a person. When it answers part of a pause, `pendingInput.approvals` carries its answers in `decision`, and `continue()` sends them with the person's. An approval asked again right after it was answered, with the same input, is left to a person. `update(id, { metadata })` changes the metadata of a session, whatever its status. A session resumed without the turn it waited in tells the agent the answers to its questions in words.
