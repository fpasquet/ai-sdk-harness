# Next.js starter

A chat with a coding agent working on your repository, in the smallest Next.js app that shows what the `ai-sdk-harness` packages add to the [AI SDK harnesses](https://ai-sdk.dev/docs/ai-sdk-harnesses/harness-agent): **Claude Code**, in a local [Docker Sandbox](https://docs.docker.com/ai/sandboxes/), fetched without the monorepo and running from packages on npm.

| What you see                                                                                                                | The package                                                                                    | Where              |
| --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------ |
| The agent runs its commands and edits in a microVM, your credential outside it                                              | [`ai-sdk-sandbox-sbx`](https://ai-sdk-harness.pages.dev/docs/packages/sandbox-sbx)             | `lib/sessions.ts`  |
| `ls` runs at once, `rm -rf` and `git push` are refused with the reason, the rest waits for Approve or Deny                  | [`ai-sdk-harness-approval`](https://ai-sdk-harness.pages.dev/docs/packages/harness-approval)   | `lib/policy.ts`    |
| The sandbox reaches Claude Code's API, npm and GitHub, and nothing else: a `curl` elsewhere is refused                      | [`ai-sdk-harness-network`](https://ai-sdk-harness.pages.dev/docs/packages/harness-network)     | `lib/sessions.ts`  |
| Each conversation works on a Git checkout of your repository, and the page shows its changes as a patch                     | [`ai-sdk-harness-workspace`](https://ai-sdk-harness.pages.dev/docs/packages/harness-workspace) | `lib/workspace.ts` |
| `/review` reviews the changes, with a skill the agent loads                                                                 | [`ai-sdk-harness-plugins`](https://ai-sdk-harness.pages.dev/docs/packages/harness-plugins)     | `lib/plugin.ts`    |
| The conversations on the left, several at once in the one sandbox, each suspended when idle and resumed on its next message | [`ai-sdk-harness-sessions`](https://ai-sdk-harness.pages.dev/docs/packages/harness-sessions)   | `lib/sessions.ts`  |

## Run it

You need Node.js 24 or later, and [Docker Sandboxes](https://docs.docker.com/ai/sandboxes/get-started/) installed and signed in (`sbx login`, then `sbx ls` answers without an error).

```bash
npx giget@latest gh:fpasquet/ai-sdk-harness/examples/starter-next my-agent
cd my-agent
npm install
cp .env.example .env.local   # set CLAUDE_CODE_OAUTH_TOKEN, and REPOSITORY
npm run dev                  # http://localhost:3000
```

`REPOSITORY` is the absolute path of a Git repository on your machine, or the https: URL of a public one: each conversation gets a checkout of it, at its last commit. Without it, the agent works in an empty directory and the page shows no changes.

The first message installs Claude Code in a sandbox and saves it as a template image, which takes a minute or two. The next conversations start in seconds.

## Try it

- **"Fix the failing test"**, or any change: the agent reads and runs what the policy allows at once, asks before it edits a file, and the patch of its changes shows under the conversation. Nothing is committed, nor pushed: you review the patch, and apply it with `git apply` on your side.
- **"Run `rm -rf build`"**: refused by the policy, and the agent is told why.
- **"Fetch https://example.com with curl"**: the policy asks you; approved, the request is still refused by the sandbox's network.
- **`/review`**: the plugin's command, expanded on the server, and its `code-review` skill.
- **A second conversation** while the first one works: both run side by side in the sandbox, each in a checkout of its own.

## How it works

| File                           | What it does                                                                                                                                   |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/sessions.ts`              | The `HarnessAgent`, the sandbox the conversations share, closed to all but what the agent needs, and the session manager the policy answers in |
| `lib/policy.ts`                | What runs at once, what is refused, what asks                                                                                                  |
| `lib/workspace.ts`             | The repository, from `REPOSITORY`                                                                                                              |
| `lib/plugin.ts`                | The skill and the `/review` command                                                                                                            |
| `app/api/chat/route.ts`        | One turn: the first message opens a session, an approval answered continues the paused turn                                                    |
| `app/api/sessions/`            | The conversations, one with its messages, and its changes as a patch                                                                           |
| `app/page.tsx`, `app/chat.tsx` | The page: the conversations, the chat with its approvals, the patch                                                                            |

The conversations are kept in memory: a restart of the server forgets them, while the sandbox and its files stay. `sbx rm ai-sdk-harness-starter-next` removes it.

## Next steps

- **Another coding agent, another sandbox**: change the agent and `openSandbox()` in `lib/sessions.ts`, see [Choosing a sandbox](https://ai-sdk-harness.pages.dev/docs/choosing-a-sandbox).
- **"Always allow"** for an approval, and a form for the agent's questions: see [Approving tool calls](https://ai-sdk-harness.pages.dev/docs/approving-tool-calls).
- **Publish the changes**: commit the patch on a clone at its `base` with your own identity, see [Reading what the agent changed](https://ai-sdk-harness.pages.dev/docs/packages/harness-workspace#reading-what-the-agent-changed).
- **Everything at once**: the [Next.js example](https://ai-sdk-harness.pages.dev/docs/examples/next-chat) has every sandbox, a marketplace of plugins, and the UI components of the docs' registry.
