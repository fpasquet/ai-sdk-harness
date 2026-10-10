# ai-sdk-harness

<p align="center">
  <a href="https://github.com/fpasquet/ai-sdk-harness/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/fpasquet/ai-sdk-harness/actions/workflows/ci.yml/badge.svg" /></a>
  <a href="https://github.com/fpasquet/ai-sdk-harness/actions/workflows/quality.yml"><img alt="Quality" src="https://github.com/fpasquet/ai-sdk-harness/actions/workflows/quality.yml/badge.svg" /></a>
  <img alt="Node &gt;= 24" src="https://img.shields.io/badge/node-%3E%3D24-3c873a" />
  <img alt="TypeScript strict" src="https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white" />
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg" /></a>
</p>

Community packages for the [Vercel AI SDK harnesses](https://ai-sdk.dev/docs/ai-sdk-harnesses/harness-agent), the `HarnessAgent` that drives Claude Code, Codex, OpenCode and other coding-agent runtimes from your application.

![The Next.js example: Claude Code, running in a Docker Sandbox, wrote a script, ran it and answered with a table](docs/public/screenshots/next-chat/conversation.png)

| Package                                                  | What it does                                                                                                                                       | npm                                                                                                                     |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| [`ai-sdk-sandbox-sbx`](packages/sandbox-sbx)             | Runs a harness agent in a local [Docker Sandbox](https://docs.docker.com/ai/sandboxes/) microVM, through `sbx`                                     | [![npm](https://img.shields.io/npm/v/ai-sdk-sandbox-sbx)](https://www.npmjs.com/package/ai-sdk-sandbox-sbx)             |
| [`ai-sdk-sandbox-cloud-run`](packages/sandbox-cloud-run) | Runs a harness agent in a [Cloud Run sandbox](https://docs.cloud.google.com/run/docs/code-execution) on Google Cloud, scaled to zero between turns | [![npm](https://img.shields.io/npm/v/ai-sdk-sandbox-cloud-run)](https://www.npmjs.com/package/ai-sdk-sandbox-cloud-run) |
| [`ai-sdk-sandbox-runtime`](packages/sandbox-runtime)     | Runs a harness agent on this machine behind [Anthropic Sandbox Runtime](https://github.com/anthropics/sandbox-runtime) (srt), with no container    | [![npm](https://img.shields.io/npm/v/ai-sdk-sandbox-runtime)](https://www.npmjs.com/package/ai-sdk-sandbox-runtime)     |

```ts
import { HarnessAgent } from '@ai-sdk/harness/agent';
import { createClaudeCode } from '@ai-sdk/harness-claude-code';
import { createSbxNetworkSandboxSession } from 'ai-sdk-sandbox-sbx';

const agent = new HarnessAgent({ harness: createClaudeCode() });
const sandboxSession = await createSbxNetworkSandboxSession({
  ports: [4000],
  setup: ['npm install --global --silent pnpm@10'],
  template: await agent.getSandboxTemplate(),
});
const session = await agent.createSession({ sandboxSession });
const { text } = await agent.generate({ session, prompt: 'Write fizzbuzz in Rust and run it' });
```

## Repository layout

A pnpm + Turborepo monorepo.

```text
packages/
  sandbox-sbx/        ai-sdk-sandbox-sbx, published to npm
  sandbox-cloud-run/  ai-sdk-sandbox-cloud-run, published to npm (client and sandbox service)
  sandbox-runtime/    ai-sdk-sandbox-runtime, published to npm (srt on this host)
  configs/            shared @repo/* presets (build, eslint, prettier, typescript, vitest)
examples/
  next-chat/          a Next.js useChat page talking to Claude Code in a Docker Sandbox
docs/                 the Fumadocs documentation site
scripts/              screenshots of the example (`pnpm screenshots`)
```

## Quick start

Prerequisites: Node.js ≥ 24, pnpm ≥ 10, and [Docker Sandboxes](https://docs.docker.com/ai/sandboxes/get-started/) (`sbx`) to run the example and the e2e tests — or, on Linux, `bubblewrap`, `socat` and `ripgrep` to run them with srt instead (`EXAMPLE_SANDBOX=srt`, see [`ai-sdk-sandbox-runtime`](packages/sandbox-runtime#linux)).

```bash
pnpm install
pnpm build
cp examples/next-chat/.env.example examples/next-chat/.env.local   # set CLAUDE_CODE_OAUTH_TOKEN
pnpm example:dev                                                   # http://localhost:3000
```

## Common commands

```bash
pnpm format:check     # Prettier
pnpm lint             # ESLint
pnpm typecheck        # tsc --noEmit
pnpm test             # unit tests, against a fake sbx, a fake Cloud Run sandbox CLI and a fake srt
pnpm test:e2e         # e2e tests, against the real sbx and srt, and a deployed Cloud Run service when CLOUD_RUN_SANDBOX_URL is set
pnpm build            # every package, the example and the docs
pnpm docs:dev         # the documentation site on http://localhost:3002
pnpm example:dev      # the Next.js example on http://localhost:3000
pnpm screenshots      # regenerate the screenshots of the example (a real Claude Code and Codex turn)
pnpm changeset        # describe a change to a published package
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for day-to-day development, [MAINTAINERS.md](MAINTAINERS.md) for releases and repository administration, and [SECURITY.md](SECURITY.md) to report a vulnerability. Guidance for coding agents lives in [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE)
