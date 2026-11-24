# Sessions

A harness session is one conversation of the agent in a sandbox: `agent.createSession({ sandboxSession })`. How long it lives depends on the app.

## One session per run

A script, a CLI, a job or a webhook that runs one task: create the session, run the turn, end it, and stop the sandbox, which the next run resumes (`openSandbox()` of [sandboxes.md](sandboxes.md)).

```ts
const sandboxSession = await openSandbox();
const session = await agent.createSession({ sandboxSession });

try {
  const result = await agent.stream({ session, prompt, abortSignal });
  for await (const part of result.fullStream) {
    if (part.type === 'text-delta') process.stdout.write(part.text);
  }
} finally {
  await session.destroy();
  // Keeps the sandbox and its files for the next run; sandboxSession.destroy() would remove them.
  await sandboxSession.stop();
}
```

- `agent.generate({ session, prompt })` when the caller wants the final text only; `agent.stream()` to show the turn as it goes. In a route, `result.toUIMessageStreamResponse()` feeds `useChat` of `@ai-sdk/react`.
- Each run is a new conversation, in a directory of its own in the sandbox. To work on the user's project, mount it (`workspace` on `sbx`, `microsandbox` and `runtime`) or give each session a Git checkout with `ai-sdk-harness-workspace`.
- Pass an `abortSignal` (the request's, or one aborted on `SIGINT`), so the `finally` runs when the user stops.

## Conversations: `ai-sdk-harness-sessions`

A chat, or any app where a conversation spans several messages, several run at once, idle ones stop costing, and they outlive a restart.

```bash
<pm> add ai-sdk-harness-sessions
```

```ts
import { createSessionManager, sharedSandbox } from 'ai-sdk-harness-sessions';

export const sessions = createSessionManager<{ title: string }>({
  agent: () => agent,
  sandboxes: sharedSandbox({
    open: openSandbox,
    // One port per live session, for its bridge: four at once, a fifth suspends the idlest.
    ports: Array.from({ length: 4 }, (_, i) => 4001 + i),
  }),
  idleTimeoutMs: 10 * 60_000,
});

process.once('SIGTERM', () => void sessions.shutdown().finally(() => process.exit(0)));
```

```ts
// The route: the first message creates the session, each one starts a turn.
if ((await sessions.get(id)) === undefined) {
  await sessions.create({ id, metadata: { title: 'New conversation' } });
}
const turn = await sessions.send(id, { message: messages.at(-1), abortSignal: request.signal });
return turn.toUIMessageStreamResponse();
```

`agent` and `openSandbox` are those of the harness and the sandbox chosen: a Codex agent, a Cloud Run `openSandbox()`, nothing else changes.

Ask the user:

- **Can conversations see each other's files?** Yes (one user, one project) → `sharedSandbox({ open, ports })`, one sandbox with a view per session; it needs `fork()`, which `sbx`, `cloud-run`, `gce` and `runtime` have. No (one per user or per repository) → `sandboxPerSession({ create, resume, maxSessions })`, a sandbox each, stopped when the session is suspended; the only choice with `microsandbox`.
- **Must conversations outlive a restart, or run on several instances?** The default store is in memory. On one machine, `store: createFileSessionStore('.data/sessions')` from `ai-sdk-harness-sessions/file` (0.4.3 or later) keeps them in JSON files, readable by their owner alone; keep that directory out of Git. On several instances, implement `SessionStore` on their database (the package's README has recipes for Drizzle, Prisma and MikroORM, and `sessionStoreChecks()` to test it). Either way, seal the resume states with `withEncryptedResumeState()` when they leave the machine.
- **Should the agent ask before acting?** `permissionMode: 'allow-reads'` on Claude Code pauses the turn until the user answers in `useChat`, then `sessions.continue(id, { message })`. Codex cannot ask before its own tools (`permissionMode: 'allow-all'` only); any harness asks before the app's tools with `toolApproval`. To answer most requests automatically, `ai-sdk-harness-approval`.
- **One agent, or several?** `agent` is a function of the session (`agent: ({ metadata }) => …`): return the `HarnessAgent` its metadata names to offer several coding agents in one manager.

`list()`, `get(id)` and `subscribe()` give the list of conversations and their statuses to the UI; `suspend(id)` frees a session at once.
