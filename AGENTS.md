# ai-sdk-harness

## Project overview

Open-source monorepo of community packages for the Vercel AI SDK harnesses (`@ai-sdk/harness`): publishable packages under `packages/*`, a Next.js example app, shared `@repo/*` workspace presets, an English-only Fumadocs site, and the CI and release automation that publishes to npm.

| Package                       | Path                            | What it is                                                                                      |
| ----------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------- |
| `ai-sdk-sandbox-sbx`          | `packages/sandbox-sbx`          | A Docker Sandboxes (`sbx`) sandbox session for `HarnessAgent`, local or in the cloud            |
| `ai-sdk-sandbox-microsandbox` | `packages/sandbox-microsandbox` | A microsandbox sandbox session for `HarnessAgent`: a local microVM booted from any OCI image    |
| `ai-sdk-sandbox-cloud-run`    | `packages/sandbox-cloud-run`    | A Cloud Run sandbox session for `HarnessAgent`, and the sandbox service that runs the sandboxes |

Constraints:

- Open source, MIT licensed.
- Packages are published unscoped, named `ai-sdk-<kind>-<provider>`, by the release workflow through npm trusted publishing (OIDC). Only the first version of a new package is published by hand, from the `fpasquet` npm account, as `MAINTAINERS.md` describes. Check that a name is free on npm (`npm view <name>` answers E404) before creating a package.
- The packages are in their **0.x** series: they are released to be tried, and their API settles with that feedback before a 1.0.0. See [Versioning](#versioning).
- Only Node `>=24.0.0` is supported. CI tests Node 24 and 26.
- Packages are ESM-only, like the AI SDK they plug into. Public APIs are importable from the package root only.
- The documentation site targets package consumers, never maintainers of the monorepo itself: maintainers read `CONTRIBUTING.md` and `MAINTAINERS.md`.

---

## Technical stack

pnpm workspaces, TypeScript (strict, `nodenext`), Vitest for tests, ESLint + Prettier, Turborepo for task orchestration, Changesets for versioning and publishing, Next.js for the example and Fumadocs (Next.js + MDX) for the documentation site. Exact versions live in the respective `package.json` files, pnpm's in the root `packageManager`.

Shared ESLint / Prettier / TypeScript / Vitest rules live in `packages/configs/*` and are consumed as `@repo/*` packages with `workspace:*`. Never duplicate compiler, lint, or test options downstream: extend the preset.

pnpm only runs the install scripts of the dependencies listed in `pnpm-workspace.yaml#allowBuilds`, and fails the install on any other: a new dependency that needs one goes there.

---

## Architecture

The agent should introspect the workspace before editing; only the non-obvious rules are listed here.

- `packages/<name>` is the only path for publishable packages. New packages mirror the shape of `packages/sandbox-sbx`.
- The client code of a sandbox package (`src/` of `ai-sdk-sandbox-sbx` and `ai-sdk-sandbox-microsandbox`, `src/client/` of `ai-sdk-sandbox-cloud-run`) is split into the same folders, so the packages read alike: `errors/` (public errors), `utils/`, `transport/` (the only way to reach a sandbox), `network/` (what crosses the sandbox's boundary: credentials, ports, network policy; not in `ai-sdk-sandbox-cloud-run`, whose service handles it on its side), `session/` (the `SandboxSession` implementations) and `lifecycle/` (create, resume, templates). Its root keeps the settings types and `provider-id.ts`. No barrel files: `src/index.ts` is the only one.
- Each layer of a client only imports the ones below it: `errors/` and `utils/` import nothing of the package, then `transport/` ← `network/` ← `session/` ← `lifecycle/`. `sandboxClientLayers()` of `@repo/eslint-config/boundaries` enforces it with `no-restricted-imports`, and each package's `eslint.config.mjs` declares its other boundaries the same way. A new boundary goes there, not in a review comment.
- `packages/configs/*` are private `@repo/*` presets, never published.
- `examples/*` are consumer-side demonstrations. They are in `.changeset/config.json#ignore` and never enter the release flow. `examples/next-chat` runs on any of the sandbox packages: `EXAMPLE_SANDBOX` (`sbx` by default, `microsandbox` or `cloud-run`) picks the sandbox, see its `.env.example`.
- `docs/` is a Fumadocs site, built as a static export and deployed to Cloudflare Pages on pushes to `main`, independently of package releases. Static export means no server at runtime: every route is prerendered and images are served unoptimized. Package pages (`content/docs/packages/*.mdx`) `<include>` the package README: the README is the single source of a package's documentation. API reference pages (`content/docs/api-reference/*.mdx`) render the settings types with `<AutoTypeTable>`. `docs/AGENTS.md` holds the Next.js rules of the site.
- `scripts/` holds repository tooling (`generate-screenshots.ts`), not runtime code.

### `ai-sdk-sandbox-sbx`

- Mirrors the API shape of `@ai-sdk/sandbox-vercel`: `createSbxNetworkSandboxSession()` / `resumeSbxNetworkSandboxSession()` returning a `HarnessV1NetworkSandboxSession`, `restricted()` returning an `Experimental_SandboxSession`.
- The `sbx` CLI is the only way the package reaches a sandbox (`src/transport/sbx-cli.ts`). Arguments go to `spawn` as-is, never through a host shell; in-sandbox scripts (`src/transport/sandbox-scripts.ts`) take their inputs as positional arguments.
- `src/network/` holds what crosses the sandbox's boundary: credential brokering through the Docker Sandboxes proxy and published ports.
- Unit tests run against `test/fake-sbx.mjs`, a stand-in `sbx` that runs `exec` on the host in a temporary directory. `test/*.e2e-spec.ts` run against the real `sbx` and are not part of CI (GitHub runners have no Docker Sandboxes).

### `ai-sdk-sandbox-microsandbox`

- Mirrors the API and the folders of `ai-sdk-sandbox-sbx`: `createMicrosandboxNetworkSandboxSession()` / `resumeMicrosandboxNetworkSandboxSession()`.
- The `microsandbox` SDK (a native addon that ships the `msb` runtime) is the only way the package reaches a sandbox, and only `src/transport/` imports it at runtime. Commands go to the in-VM agent as an argument array, their variables on the SDK's channel; in-sandbox scripts (`src/transport/sandbox-scripts.ts`) take their inputs as positional arguments. File operations are commands too, run as the sandbox's user, so the files the harness writes are that user's.
- Behaviours of microsandbox its docs leave out, checked on the real runtime: the SDK only launches a runtime of its own version, and one installed in `~/.microsandbox` wins over the bundled one; a secret with a new placeholder, and TLS interception, need a restart of the microVM (`modify({ policy: 'restart' })`, which kills the running commands), a new value for a known placeholder is live; HTTPS hosts only match a network policy, and secrets only reach HTTPS requests, with TLS interception on; ports and the network policy are fixed at creation; a disk snapshot keeps the disk alone, so a restore sets resources, user, ports and mounts again; a command ends when the client that started it disconnects; reading a directory through the SDK's `fs` hangs. Keep them in mind before changing how the package drives the SDK.
- The real value of a brokered credential is stored by microsandbox in its SQLite database on the host: the README says so, keep it said.
- Unit tests resolve `microsandbox` to `test/fake-microsandbox.ts` (a Vitest alias), a stand-in SDK that runs commands on the host in a temporary directory per sandbox, guest paths mapped into it. `test/*.e2e-spec.ts` run against the real runtime, are skipped without KVM or Apple Silicon, and are not part of CI.

### `ai-sdk-sandbox-cloud-run`

- One folder per runtime under `src/`. The client (`src/client/`, exported from `src/index.ts`) mirrors the API and the folders of `ai-sdk-sandbox-sbx`: `createCloudRunNetworkSandboxSession()` / `resumeCloudRunNetworkSandboxSession()`. The sandbox service (`src/server/`) is the package's `bin` (`ai-sdk-sandbox-cloud-run serve`, `src/server/cli.ts`), deployed in a Cloud Run service with `--sandbox-launcher`; it is not exported. They speak the HTTP API of `src/server/http/routes.ts`, whose bodies are typed once in `src/protocol/api.ts`, and the frames of `src/protocol/frames.ts`. The server never imports the client, nor the client the server: what they share lives in `src/protocol/`.
- The service is split by concern: `http/` (server, routes, streams, tunnels), `sandboxes/` (the sandboxes it manages), `runtime/` (the `sandbox` CLI of Cloud Run), `egress/` (proxy, policy, network guard) and `snapshots/` (snapshot stores). `cli.ts`, `config.ts`, `logger.ts` and `package-version.ts` stay at its root: `config.ts` and `package-version.ts` locate `in-sandbox/` and `package.json` relative to themselves.
- The service has no runtime dependency: plain `node:http`, and only type imports from `@ai-sdk/harness`. `src/in-sandbox/*` run inside the sandboxes with the image's Node.js and import nothing but `src/protocol/`.
- The `sandbox` CLI of Cloud Run is the only way the service reaches a sandbox (`src/server/runtime/sandbox-cli.ts`). It loses exit codes: every command runs under `ExitCodeCarrier`. Behaviours of the CLI that Google does not document were checked on the real Cloud Run; keep them in mind before changing how the service drives it.
- Security rules of the service, each with its tests in `src/security.spec.ts`: Cloud Run logs every command line it runs in a sandbox, so nothing but `node …/launch.js` may ever be on one (commands, variables and directories go on the launcher's stdin); a credential the service holds never enters a sandbox (`Sandbox.assertNoSecret`); the egress proxy never connects to a private address (`src/server/egress/network-guard.ts`), checked after DNS resolution. Credential brokering is not optional.
- Unit tests start the real service in-process over `test/fake-sandbox.mjs`, which isolates nothing, and drive it with the real client. The suite builds the package first, into `node_modules/.cache/test-build` and never into `dist`, which an app running meanwhile imports (`test/build-helpers.ts`): the service runs the built `in-sandbox/*`. `test/*.e2e-spec.ts` run against a service deployed on Cloud Run (`CLOUD_RUN_SANDBOX_URL`) and are skipped without it.

---

## Code conventions

- Public exports live exclusively in each package's `src/index.ts`.
- Every public symbol carries TSDoc comments, which the docs' `<AutoTypeTable>` reads.
- Publishable packages declare `"type": "module"`, `"sideEffects": false`, `"engines.node": ">=24.0.0"`, and treat `@ai-sdk/*` packages as **peer** dependencies (and as devDependencies for local tests).
- Relative imports carry their `.js` extension (`nodenext`).
- Unit tests live next to the source as `*.spec.ts`; e2e tests live in `test/*.e2e-spec.ts`. Both run under Vitest.
- Documentation content is written in English only.
- Never edit generated files by hand: `CHANGELOG.md` (written by Changesets), `docs/.source`, `next-env.d.ts`, and the blocks between `BEGIN:` / `END:` markers in `AGENTS.md` and `docs/AGENTS.md`, which `turbo` and `next dev` rewrite.

---

## Versioning

- Any user-visible change to a publishable package requires a changeset (`pnpm changeset`). Write it for the people who install the package: it lands verbatim in its `CHANGELOG.md` and its GitHub release. The example, the docs site and the `@repo/*` presets never need one.
- In the 0.x series, a breaking change is a `minor` with a `BREAKING:` note in the changeset body, anything else a `patch`. Never write a `major` changeset: it would release 1.0.0, a step the maintainers take on purpose.
- Never change a package's `version` by hand, nor run `pnpm version-packages` or `pnpm release`: releases go through CI, as `MAINTAINERS.md` describes.

## Commits

- Commits follow [Conventional Commits](https://www.conventionalcommits.org), checked by commitlint on every commit and in CI. The scope is the package folder (`sandbox-sbx`, `sandbox-microsandbox`, `sandbox-cloud-run`) or the area (`docs`, `ci`, `deps`, `eslint`…).
- Pull requests are squash-merged with their title as the commit message, so the title follows the same convention.
- The pre-commit hook runs lint-staged and `pnpm typecheck`. Never bypass the hooks (`--no-verify`): fix what they report.

---

## Available commands

The agent should read `package.json` for the full list of scripts.

- Targeted iteration: `pnpm --filter <package> <script>`, e.g. `pnpm --filter ai-sdk-sandbox-cloud-run test`.
- Cross-cutting actions live in root `package.json` scripts (docs, example app, screenshots, package gates). Prefer them over recreating their command lines.

### Mandatory validation before delivery

Every change must pass:

1. `pnpm format:check`
2. `pnpm lint`
3. `pnpm typecheck`
4. `pnpm test`
5. `pnpm build`

Add when the change touches the matching area:

- `pnpm --filter ai-sdk-sandbox-sbx test:e2e` when changing how the package drives `sbx` (needs Docker Sandboxes on the machine; `SBX_E2E_CLOUD=1` adds the cloud mode).
- `pnpm --filter ai-sdk-sandbox-microsandbox test:e2e` when changing how the package drives the `microsandbox` SDK (needs KVM or Apple Silicon, and a runtime of the SDK's version: an `msb` installed in `~/.microsandbox` wins over the bundled one; otherwise point `MSB_HOME` at another, short, directory).
- `CLOUD_RUN_SANDBOX_URL=… pnpm --filter ai-sdk-sandbox-cloud-run test:e2e` when changing how the service drives the `sandbox` CLI (needs the service deployed on Cloud Run, the gcloud account an invoker).
- `pnpm docs:build` when editing anything under `docs/` or a README it includes.
- `pnpm screenshots` when changing the interface of `examples/next-chat`: the docs and the READMEs show its screenshots (needs Docker Sandboxes, a Claude and an OpenAI credential).
- `pnpm pack:dry-run`, `pnpm publint`, and `pnpm attw` when editing a publishable package's manifest or its public exports.

No change is considered ready while any required step fails.

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->
