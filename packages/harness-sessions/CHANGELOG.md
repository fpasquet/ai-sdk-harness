# ai-sdk-harness-sessions

## 0.2.1

### Patch Changes

- 116b98c: A resume that fails no longer closes the session's sandbox lease: it hands it back with `suspend()`, as a suspension does, so the sandbox and the files the next try resumes from are kept. With `sandboxPerSession()`, a failed resume destroyed the session's sandbox while the session stayed `suspended`, waiting to resume from it.

## 0.2.0

### Minor Changes

- 05ff36c: The `approve` option answers the approvals a turn asks for before anyone sees them — an approval policy, the grants of the session: a verdict is sent at once and the turn goes on in the same stream, the client seeing the answer; `undefined` leaves the approval to a person. When it answers part of a pause, `pendingInput.approvals` carries its answers in `decision`, and `continue()` sends them with the person's. An approval asked again right after it was answered, with the same input, is left to a person. `update(id, { metadata })` changes the metadata of a session, whatever its status. A session resumed without the turn it waited in tells the agent the answers to its questions in words.

## 0.1.0

### Minor Changes

- d1ae211: First release: sessions for AI SDK harness agents. `createSessionManager()` runs the conversations of your users with any `HarnessAgent` — Claude Code, Codex or another runtime — through their whole lifecycle: `create()` opens a session in the background, `send()` streams a turn in reply to a message, one turn at a time, and the session keeps its conversation, readable with `get()` and `list()`. A turn that pauses on a tool approval, or on a tool your application runs, leaves the session `awaiting-input` until `continue()` brings the answers, which it can read from the message `useChat` sends back. A session idle for `idleTimeoutMs` is suspended, its harness session stopped with its state and its sandbox freed, and resumed where it was on the next message; `shutdown()` suspends every session when your server stops, so the next start resumes them, and a session a crash left live is marked `interrupted`. `subscribe()` sends every change, for a list that follows the sessions live.
  
  Where each session runs is up to `sharedSandbox()`, which gives every session a view of one sandbox with a port of its own for its bridge (`fork()` of `ai-sdk-sandbox-sbx` and `ai-sdk-sandbox-cloud-run`), suspending the session idle the longest when every port is taken and stopping the sandbox once no session holds it with `stopWhenUnused`, or `sandboxPerSession()`, which gives each one a sandbox of its own. Sessions are kept in a `SessionStore`: `createMemorySessionStore()` by default, or yours on your database. `SessionNotFoundError`, `SessionConflictError` and `SessionCapacityError` say what went wrong, with an `isInstance()` that works across copies of the package.
