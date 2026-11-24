---
name: setup-ai-sdk-harness
description: |
  Set up a coding agent (Claude Code, Codex, OpenCode…) with the Vercel AI SDK harnesses (`@ai-sdk/harness`) and the ai-sdk-harness community packages in a Node.js application.
  Introspects the project, picks the sandbox the agent runs in (ai-sdk-sandbox-sbx, -microsandbox, -runtime, -cloud-run or -gce), closes its network to the hosts it needs with ai-sdk-harness-network, and chooses between one session per run and conversations managed by ai-sdk-harness-sessions — asking the user to confirm the choices that matter.
  Use when a user wants to run a coding agent in a sandbox from their app, add a HarnessAgent, choose a sandbox for it, restrict its network, or keep its sessions across turns.
---

# Set up an AI SDK harness agent

A `HarnessAgent` of `@ai-sdk/harness` drives a coding-agent runtime (Claude Code, Codex, OpenCode, Pi…) from the user's application, through a **harness adapter** (`@ai-sdk/harness-claude-code`…). The agent runs its commands and edits files in a **sandbox**, given to it as a `HarnessV1NetworkSandboxSession` by a sandbox package. The `ai-sdk-harness` packages provide the sandboxes, and the network, sessions, plugins and approvals around them. Wire them into the **user's** project: introspect it, ask what matters, write idiomatic code, verify a turn runs.

## Workflow

1. **Introspect the project** first — nothing else until you have this (see below).
2. **Pick the harness** and its credential (see below).
3. **Choose the sandbox** with `AskUserQuestion` → [references/sandboxes.md](references/sandboxes.md).
4. **Close the network** to the hosts the agent needs → [references/network.md](references/network.md).
5. **Choose how sessions live**: one per run, or conversations → [references/sessions.md](references/sessions.md).
6. **Verify** with one real turn (see below).

## Introspect the project

Before changing anything, gather:

- **Package manager**, from the lockfile (`pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, `bun.lock`). Use it for every install command.
- **Node.js ≥ 24** (`node --version`, `engines`, `.nvmrc`, the Dockerfile, CI) and **ESM**: every package is ESM-only. **This is a gate**: on an older Node.js, or a CommonJS project (no `"type": "module"` in its `package.json`, `require()` in its code), stop before installing anything, say what has to change (Node.js 24; `"type": "module"`, or `await import()` from CommonJS), and ask before changing it.
- **What already exists**: `@ai-sdk/harness`, a `@ai-sdk/harness-*` adapter, `ai`, a sandbox package, `HarnessAgent` in the code. Extend what is there; don't add a second agent.
- **The app's shape**: a script or CLI, a server (Express, Hono, Fastify), or **Next.js** (`next.config.*`), which needs `serverExternalPackages` (see [references/sandboxes.md](references/sandboxes.md)).
- **The project the agent works on**: its languages (`package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`…), which decide the sandbox image and the registries to open, and whether its tests need `docker compose`.
- **The host**, for a local sandbox: `sbx version` (Docker Sandboxes), `/dev/kvm` readable and writable or macOS on Apple Silicon (microsandbox), `bwrap`/`socat`/`rg` on Linux (Anthropic Sandbox Runtime). For Google Cloud: `gcloud config get project`.
- **Credentials already in the environment** or `.env*`: `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`… Never print their values.

## Pick the harness

Ask which coding agent, unless the user named one or one is already installed. Claude Code is the default: the docs and examples of these packages use it.

| Coding agent | Adapter                       | Factory              | Credential                                                                                  |
| ------------ | ----------------------------- | -------------------- | ------------------------------------------------------------------------------------------- |
| Claude Code  | `@ai-sdk/harness-claude-code` | `createClaudeCode()` | `CLAUDE_CODE_OAUTH_TOKEN` (`claude setup-token`) or `ANTHROPIC_API_KEY`, else the CLI login |
| Codex        | `@ai-sdk/harness-codex`       | `createCodex()`      | `OPENAI_API_KEY`, else the login of the `codex` CLI (a ChatGPT subscription)                |
| OpenCode     | `@ai-sdk/harness-opencode`    | `createOpenCode()`   | The key of the provider it is given: it has none of its own                                 |
| Others       | `@ai-sdk/harness-*`           | Its `create…()`      | The AI SDK's [list of adapters](https://ai-sdk.dev/docs/ai-sdk-harnesses/harness-adapters)  |

- **Credential.** Add the variable to `.env.example`, never a value, and check `.env` is ignored by Git.
- **Approvals differ.** Claude Code can ask before its commands and edits (`permissionMode: 'allow-reads'`). Codex cannot ask before its own tools yet: its adapter takes `permissionMode: 'allow-all'` only ([vercel/ai#22550](https://github.com/vercel/ai/issues/22550)). Any harness asks before the app's own tools, through `toolApproval`. Say so when the user wants a person in the loop.
- **Brokering.** Every sandbox package hands the sandbox a **placeholder** of the credential and swaps the real value in outside it, on the way to the provider. Never turn it off (`brokerCredentials: false` and the like): the agent could then read the real credential. On Cloud Run and Compute Engine it is the service's egress proxy, and cannot be turned off.
- **When the harness cannot authenticate**, check in this order: the variable is set in the application's process (not only in a shell, or in a `.env` nothing loads); the provider's host is in the sandbox's network policy; one `@ai-sdk/harness` is installed (below). Never pass the credential into the sandbox to get around it.
- **One release wave.** An adapter pins its `@ai-sdk/harness` exactly. Install the adapter and `@ai-sdk/harness` together, at their latest versions, and check one copy is installed (`npm ls @ai-sdk/harness`, `pnpm why @ai-sdk/harness`): two copies and the types no longer match.

```bash
<pm> add @ai-sdk/harness @ai-sdk/harness-claude-code <sandbox package>
```

## Choose the sandbox

Present the choice with `AskUserQuestion`, following [references/sandboxes.md](references/sandboxes.md):

- **Only what the host can run.** Offer a local sandbox when its check of the introspection passed, and the Google Cloud ones when the agent must run on a server or the user asked for it.
- **Recommend one on a concrete signal**, and put it first with `(Recommended)` on its label: `sbx` when Docker Sandboxes is installed; `microsandbox` with KVM or Apple Silicon and no Docker Sandboxes; `cloud-run` for an agent on Google Cloud that edits code and runs plain processes; `gce` when its tests need `docker compose`, a database or a machine of their own.
- Keep `header` ≤ 12 characters, and write concrete descriptions: where it runs, what isolates it, what the user must install or deploy first.

Cloud Run and Compute Engine need a **sandbox service** deployed first (the `gcloud` commands of their READMEs). Walk the user through it, or point to it; don't run `gcloud` commands that create resources without their go-ahead.

## Close the network

By default the sandbox packages differ: Docker Sandboxes applies the machine's policy (`sbx policy ls`), often open to the public internet, microsandbox reaches the public internet, srt a short default list, Cloud Run and Compute Engine the service's hosts plus the `allowedHosts` given. Propose a closed policy built with `ai-sdk-harness-network`: the harness's hosts, the registries of the project's languages, and the user's own. Follow [references/network.md](references/network.md); its main trap is the template, built under the same network.

## Choose how sessions live

- **A script, a CLI, a job, one task per run**: one harness session per run, created and destroyed around the turn, in a sandbox resumed by name. No extra package.
- **A chat or an app with conversations**, several at once, suspended when idle, resumed on the next message or after a restart: `ai-sdk-harness-sessions`. Ask whether conversations may share one sandbox (`sharedSandbox`) or must not see each other (`sandboxPerSession`).

Follow [references/sessions.md](references/sessions.md) for both.

## Verify

- Type-check (`tsc --noEmit` or the project's script).
- Run **one real turn** with a short prompt (`Write a script that prints the first ten primes, then run it.`). The first run builds the template (a minute or two); say so before running it. A second run should resume the sandbox in seconds.
- With a closed network, a refused host shows in the error of the template build, or in the turn: add it to the policy if the project needs it, don't open everything.
- Clean up what the check left, and only that: `sandboxSession.destroy()` (or `sbx rm <name>`) removes the sandbox and its files for good, so never run it on the sandbox the app resumes by name.
- Point the user at the next steps that fit their app: plugins (`ai-sdk-harness-plugins`), a Git checkout per session (`ai-sdk-harness-workspace`), approvals of the agent's commands (`ai-sdk-harness-approval`), all documented on https://ai-sdk-harness.pages.dev.
