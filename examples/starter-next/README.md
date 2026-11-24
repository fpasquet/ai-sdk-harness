# Next.js starter

A chat with a coding agent, in the smallest Next.js app that runs one: **Claude Code**, in a local [Docker Sandbox](https://docs.docker.com/ai/sandboxes/) through [`ai-sdk-sandbox-sbx`](https://ai-sdk-harness.pages.dev/docs/packages/sandbox-sbx), its conversations kept by [`ai-sdk-harness-sessions`](https://ai-sdk-harness.pages.dev/docs/managing-sessions). A `useChat` page, one route, a `.env.local` file, and packages from npm. No clone of the monorepo.

The page is one file: the agent's answers rendered as Markdown while they stream in, by [Streamdown](https://streamdown.ai), and every tool it runs in the sandbox, with its input and output. For a richer interface, [AI Elements](https://ai-sdk.dev/elements) installs chat components into the project, as the [Next.js example](https://ai-sdk-harness.pages.dev/docs/examples/next-chat) uses them.

## Run it

You need Node.js 24 or later, and [Docker Sandboxes](https://docs.docker.com/ai/sandboxes/get-started/) installed and signed in (`sbx login`, then `sbx ls` answers without an error).

```bash
npx giget@latest gh:fpasquet/ai-sdk-harness/examples/starter-next my-agent
cd my-agent
npm install
cp .env.example .env.local   # set CLAUDE_CODE_OAUTH_TOKEN, or ANTHROPIC_API_KEY
npm run dev                  # http://localhost:3000
```

The first message installs Claude Code in a sandbox and saves it as a template image, which takes a minute or two. The next conversations start in seconds.

Left empty, `.env.local` falls back to the login of the `claude` CLI on this machine. Whatever the credential, only a placeholder of it enters the sandbox: the Docker Sandboxes proxy swaps the real value in on the way to Anthropic.

## How it works

| File                    | What it does                                                                                                                                                                                                                                                                |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/sessions.ts`       | The `HarnessAgent` (Claude Code), the sandbox all conversations share (`ai-sdk-harness-starter-next`, created once and resumed afterwards), and the session manager: four conversations live at once, each suspended after 15 idle minutes and resumed on its next message. |
| `app/api/chat/route.ts` | One turn: the first message of a conversation opens its session, each message sends a turn and streams it back. The stop button aborts it.                                                                                                                                  |
| `app/page.tsx`          | The `useChat` page.                                                                                                                                                                                                                                                         |

The conversations are kept in memory: a restart of the server forgets them, while the sandbox and its files stay. `sbx rm ai-sdk-harness-starter-next` removes it.

## Next steps

- **Keep the conversations** across restarts: implement a `SessionStore` on your database, see [Keeping sessions](https://ai-sdk-harness.pages.dev/docs/packages/harness-sessions#keeping-sessions).
- **Ask before acting**: approvals of the agent's commands and edits, see [Approving tool calls](https://ai-sdk-harness.pages.dev/docs/approving-tool-calls).
- **Another coding agent, another sandbox**: change the agent and `openSandbox()` in `lib/sessions.ts`, see [Choosing a sandbox](https://ai-sdk-harness.pages.dev/docs/choosing-a-sandbox).
- **Your project**: [mount a directory](https://ai-sdk-harness.pages.dev/docs/packages/sandbox-sbx#working-on-your-files) or give each conversation a Git checkout of its own, see [Working on a repository](https://ai-sdk-harness.pages.dev/docs/working-on-a-repository).
- **Everything at once**: the [Next.js example](https://ai-sdk-harness.pages.dev/docs/examples/next-chat) has every official harness, every sandbox, the list of conversations, plugins and approvals.
