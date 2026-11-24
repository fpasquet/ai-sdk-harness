# Starter

The smallest project that runs a coding agent with the [AI SDK harnesses](https://ai-sdk.dev/docs/ai-sdk-harnesses/harness-agent): one harness, **Claude Code**, in one sandbox, a local [Docker Sandbox](https://docs.docker.com/ai/sandboxes/) through [`ai-sdk-sandbox-sbx`](https://ai-sdk-harness.pages.dev/docs/packages/sandbox-sbx). A script of some fifty lines, `agent.ts`, a `.env` file, and three packages from npm. No clone of the monorepo, no pnpm, no build step.

## Run it

You need Node.js 24 or later, and [Docker Sandboxes](https://docs.docker.com/ai/sandboxes/get-started/) installed and signed in (`sbx login`, then `sbx ls` answers without an error).

```bash
npx giget@latest gh:fpasquet/ai-sdk-harness/examples/starter my-agent
cd my-agent
npm install
cp .env.example .env   # set CLAUDE_CODE_OAUTH_TOKEN, or ANTHROPIC_API_KEY
npm start
```

The agent writes a script that prints the first ten primes, runs it in the sandbox, and streams its answer, with the tools it calls:

```text
› bash
I wrote `primes.py` in the working directory and ran it. It printed the first ten primes:
`[2, 3, 5, 7, 11, 13, 17, 19, 23, 29]`
```

Give it a prompt of your own:

```bash
npm start -- "Write fizzbuzz in Rust and run it"
```

The first run installs Claude Code in a sandbox and saves it as a template image, which takes a minute or two. It then keeps the sandbox, stopped, under the name `ai-sdk-harness-starter`: the next runs resume it in seconds, each one a new conversation in a directory of its own. `sbx rm ai-sdk-harness-starter` removes it.

Left empty, `.env` falls back to the login of the `claude` CLI on this machine. Whatever the credential, only a placeholder of it enters the sandbox: the Docker Sandboxes proxy swaps the real value in on the way to Anthropic.

## Next steps

- **Another coding agent.** Install its adapter, `@ai-sdk/harness-codex` for Codex for instance, and pass `createCodex()` to the `HarnessAgent` instead of `createClaudeCode()`. The AI SDK lists [the adapters](https://ai-sdk.dev/docs/ai-sdk-harnesses/harness-adapters).
- **Another sandbox.** A microVM booted from any OCI image, a Cloud Run sandbox or a Compute Engine VM on Google Cloud, or your machine behind Anthropic Sandbox Runtime: [Choosing a sandbox](https://ai-sdk-harness.pages.dev/docs/choosing-a-sandbox) compares them.
- **Your project.** [Mount a directory](https://ai-sdk-harness.pages.dev/docs/packages/sandbox-sbx#working-on-your-files), or a private clone of a repository, so the agent works on your files.
- **More of the agent.** [Plugins](https://ai-sdk-harness.pages.dev/docs/adding-plugins), [sessions](https://ai-sdk-harness.pages.dev/docs/managing-sessions) that outlive a run, [approvals](https://ai-sdk-harness.pages.dev/docs/approving-tool-calls) of its commands, and [the network](https://ai-sdk-harness.pages.dev/docs/packages/harness-network) its sandbox may reach.
- **A chat.** The [Next.js example](https://ai-sdk-harness.pages.dev/docs/examples/next-chat) streams turns to a `useChat` page, with sessions, plugins, approvals and the network, on Claude Code, Codex or Pi.
