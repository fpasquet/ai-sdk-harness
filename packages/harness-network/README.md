# ai-sdk-harness-network

<p align="center">
  <a href="https://www.npmjs.com/package/ai-sdk-harness-network"><img alt="npm" src="https://img.shields.io/npm/v/ai-sdk-harness-network" /></a>
  <a href="https://github.com/fpasquet/ai-sdk-harness/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/fpasquet/ai-sdk-harness/actions/workflows/ci.yml/badge.svg" /></a>
  <img alt="Node &gt;= 24" src="https://img.shields.io/badge/node-%3E%3D24-3c873a" />
  <img alt="TypeScript strict" src="https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white" />
  <a href="https://github.com/fpasquet/ai-sdk-harness/blob/main/LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg" /></a>
</p>

The hosts the sandbox of an [AI SDK harness agent](https://ai-sdk.dev/docs/ai-sdk-harnesses/harness-agent) may reach, so that its network can be **closed to everything else**: trusted lists for the forges, package registries, toolchains, container registries and Linux archives of the whole ecosystem, the hosts of every `@ai-sdk/harness-*` runtime and of the model providers, and the functions that check and merge them — with those of a workspace and of plugins — into the network policy every sandbox package takes.

## At a glance

A coding agent needs few hosts: its model's API, the registry its runtime installs from, the forge of its repository, the registries of the project's packages. Every sandbox package takes them as `allowedHosts` and lets nothing else through; every application ends up writing the same list. This package writes it once:

```ts
import { harnessHosts, networkPolicy, trustedHosts } from 'ai-sdk-harness-network';
import { createSbxNetworkSandboxSession } from 'ai-sdk-sandbox-sbx';

const sandboxSession = await createSbxNetworkSandboxSession({
  ports: [4000],
  networkPolicy: networkPolicy(
    trustedHosts('github', 'javascript'), // GitHub, npm, Yarn, pnpm, Bun, JSR, Deno, Node.js
    harnessHosts(harness.harnessId), // Claude Code: registry.npmjs.org, api.anthropic.com
    ['api.acme.dev'], // your own
  ),
});
// { mode: 'custom', allowedHosts: ['*.githubusercontent.com', 'api.acme.dev', 'api.anthropic.com', …] }
```

| The sandbox tries to reach                  | With the policy above                                        |
| ------------------------------------------- | ------------------------------------------------------------ |
| `git clone https://github.com/acme/widgets` | Allowed: `github.com`                                        |
| `pnpm install`                              | Allowed: `registry.npmjs.org`                                |
| A release asset, a raw file of GitHub       | Allowed: `*.githubusercontent.com`, where GitHub serves them |
| The model API, for the agent's turn         | Allowed: `api.anthropic.com`                                 |
| `curl https://example.com`                  | Refused by the sandbox's proxy                               |
| `pip install requests`                      | Refused: Python was not listed (`trustedHosts('python')`)    |

## Installation

```bash
pnpm add ai-sdk-harness-network
```

No dependency, peer or runtime: it is lists of hosts and the functions that check them. It runs in the browser too, where a settings form checks the hosts a user types as your server does.

## Usage

### Trusted hosts

`trustedHosts(...names)` gives the hosts of the services named, or of the groups of them, every service without any. `TRUSTED_HOSTS` holds them by service, `TRUSTED_GROUPS` the services of each group (— for a service in none):

| Group            | Service        | Hosts                                                                                                            |
| ---------------- | -------------- | ---------------------------------------------------------------------------------------------------------------- |
| `forges`         | `github`       | `github.com`, `api.github.com`, `codeload.github.com`, `*.githubusercontent.com`                                 |
|                  | `gitlab`       | `gitlab.com`, `registry.gitlab.com`, `cdn.registry.gitlab-static.net`                                            |
|                  | `bitbucket`    | `bitbucket.org`, `api.bitbucket.org`                                                                             |
|                  | `codeberg`     | `codeberg.org`                                                                                                   |
| `javascript`     | `npm`          | `registry.npmjs.org`                                                                                             |
|                  | `yarn`         | `registry.yarnpkg.com`, `repo.yarnpkg.com`                                                                       |
|                  | `pnpm`         | `get.pnpm.io`                                                                                                    |
|                  | `bun`          | `bun.sh`                                                                                                         |
|                  | `jsr`          | `jsr.io`, `npm.jsr.io`                                                                                           |
|                  | `deno`         | `deno.land`, `dl.deno.land`                                                                                      |
|                  | `nodejs`       | `nodejs.org`, `unofficial-builds.nodejs.org`                                                                     |
| `python`         | `pypi`         | `pypi.org`, `files.pythonhosted.org`                                                                             |
|                  | `uv`           | `astral.sh`, `releases.astral.sh`                                                                                |
|                  | `conda`        | `conda.anaconda.org`, `repo.anaconda.com`                                                                        |
|                  | `cpython`      | `www.python.org`, `bootstrap.pypa.io`                                                                            |
| `rust`           | `crates`       | `crates.io`, `index.crates.io`, `static.crates.io`                                                               |
|                  | `rustup`       | `sh.rustup.rs`, `static.rust-lang.org`                                                                           |
| —                | `go`           | `proxy.golang.org`, `storage.googleapis.com`, `sum.golang.org`, `go.dev`, `dl.google.com`                        |
| `jvm`            | `maven`        | `repo.maven.apache.org`, `repo1.maven.org`                                                                       |
|                  | `google-maven` | `maven.google.com`, `dl.google.com`                                                                              |
|                  | `gradle`       | `services.gradle.org`, `downloads.gradle.org`, `plugins.gradle.org`, `plugins-artifacts.gradle.org`              |
| —                | `rubygems`     | `rubygems.org`, `index.rubygems.org`                                                                             |
| —                | `packagist`    | `packagist.org`, `repo.packagist.org`, `getcomposer.org`                                                         |
| `dotnet`         | `nuget`        | `api.nuget.org`, `www.nuget.org`, `globalcdn.nuget.org`                                                          |
|                  | `dotnet-sdk`   | `dot.net`, `builds.dotnet.microsoft.com`                                                                         |
| —                | `pub`          | `pub.dev`, `storage.googleapis.com`                                                                              |
| —                | `hex`          | `hex.pm`, `repo.hex.pm`, `builds.hex.pm`                                                                         |
| —                | `cocoapods`    | `cdn.cocoapods.org`, `trunk.cocoapods.org`                                                                       |
| —                | `swift`        | `download.swift.org`                                                                                             |
| —                | `cran`         | `cloud.r-project.org`, `cran.r-project.org`                                                                      |
| —                | `hackage`      | `hackage.haskell.org`, `downloads.haskell.org`, `get-ghcup.haskell.org`                                          |
| —                | `cpan`         | `www.cpan.org`, `cpan.metacpan.org`, `fastapi.metacpan.org`                                                      |
| —                | `zig`          | `ziglang.org`                                                                                                    |
| `infrastructure` | `terraform`    | `registry.terraform.io`, `releases.hashicorp.com`                                                                |
|                  | `opentofu`     | `registry.opentofu.org`                                                                                          |
|                  | `helm`         | `get.helm.sh`                                                                                                    |
|                  | `kubernetes`   | `dl.k8s.io`, `registry.k8s.io`, `*.pkg.dev`                                                                      |
| `containers`     | `docker-hub`   | `registry-1.docker.io`, `auth.docker.io`, `production.cloudfront.docker.com`, `production.cloudflare.docker.com` |
|                  | `ghcr`         | `ghcr.io`, `pkg-containers.githubusercontent.com`                                                                |
|                  | `quay`         | `quay.io`, `*.quay.io`                                                                                           |
|                  | `mcr`          | `mcr.microsoft.com`, `*.data.mcr.microsoft.com`                                                                  |
|                  | `gcr`          | `gcr.io`, `*.pkg.dev`                                                                                            |
| `linux`          | `debian`       | `deb.debian.org`, `security.debian.org`                                                                          |
|                  | `ubuntu`       | `archive.ubuntu.com`, `security.ubuntu.com`, `ports.ubuntu.com`                                                  |
|                  | `alpine`       | `dl-cdn.alpinelinux.org`                                                                                         |

Each list names the hosts its default tool reaches, redirects followed: Gradle's distributions, uv, pnpm, Bun and OpenTofu's providers download from GitHub's releases (`github`), Go's module proxy from Cloud Storage. And the domain beside its `*.` wildcard: whether `*.example.com` covers `example.com` itself differs from one sandbox to another (microsandbox's does, srt's does not). `test/presets.e2e-spec.ts` fetches from each service, a Docker Hub image included, in a Docker Sandbox closed to all but `trustedHosts()`, and checks the proxy refused nothing.

Some services rely on hosts shared with everyone: `storage.googleapis.com` (Go, Dart and Flutter), `dl.google.com`, `*.pkg.dev`. A sandbox that reaches them reaches any public bucket or registry there: name the services a project needs rather than all of them when that matters.

### The harness's own hosts

`harnessHosts(harnessId, options?)` gives the hosts the harness's runtime reaches from the sandbox, by the `harnessId` of its adapter: where it installs, its own service, and the API of its models' provider. `HARNESS_NETWORK` holds them, read from each adapter — the packages it installs, the hosts its credentials are brokered to — and from each runtime's network documentation:

| Harness             | Installs from                        | Its service                                                                    | Its provider        | Optional                                                                                     |
| ------------------- | ------------------------------------ | ------------------------------------------------------------------------------ | ------------------- | -------------------------------------------------------------------------------------------- |
| `claude-code`       | `registry.npmjs.org`                 |                                                                                | `anthropic`         | `http-intake.logs.us5.datadoghq.com`, `browser-intake-us5-datadoghq.com` (telemetry, errors) |
| `codex`             | `registry.npmjs.org`                 |                                                                                | `openai`, `chatgpt` |                                                                                              |
| `opencode`          | `registry.npmjs.org`                 |                                                                                | none: name one      | `models.dev` (its list of models)                                                            |
| `deepagents`        | `registry.npmjs.org`                 |                                                                                | `anthropic`         |                                                                                              |
| `cursor`            | `cursor.com`, `downloads.cursor.com` | `*.cursor.sh`                                                                  |                     |                                                                                              |
| `github-copilot`    | `registry.npmjs.org`                 | `github.com`, `api.github.com`, `api.githubcopilot.com`, `*.githubcopilot.com` |                     | `collector.github.com`, `copilot-telemetry.githubusercontent.com`, `default.exp-tas.com`     |
| `grok-build`        | `registry.npmjs.org`                 | `cli-chat-proxy.grok.com` (a subscription)                                     | `xai`               | `code.grok.com`, `assets.grok.com`                                                           |
| `cline`, `pi`, `fx` | —                                    | —                                                                              | —                   | They run on your server, the sandbox their file system and shell only: it reaches nothing    |

- `provider` takes another provider in place of the harness's own: `harnessHosts('claude-code', { provider: 'gateway' })` for the Vercel AI Gateway, `{ provider: 'amazon-bedrock', region: 'eu-west-3' }`, `{ provider: 'google-vertex', region: 'europe-west1' }`. OpenCode has no provider of its own: name it.
- `optional: true` adds what a turn does without: refused, the runtime carries on. Most runtimes turn it off in their settings (`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` for Claude Code, `--disable-client-telemetry` for Copilot).
- `install: false` leaves out where the runtime installs from, for a sandbox started from a template that holds it.
- Codex calls `api.openai.com` with an API key and `chatgpt.com` with a ChatGPT sign-in; Claude Code and Codex refresh a subscription's token on your server, never in the sandbox.
- An ACP agent (`@ai-sdk/harness-acp`) has the id you give it and the hosts of the agent you install: list them, beside `registry.npmjs.org` where its bridge installs from. A harness the package does not know gives none.

### Model providers

`providerHosts(provider, location?)` gives the hosts of a provider's API, by the name of its AI SDK provider package (`@ai-sdk/<provider>`): the default `baseURL` of that package. `PROVIDER_HOSTS` holds those whose host is the same for everyone:

| Provider                                                                                                                                                                                                                                                                                    | Hosts                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `anthropic`, `openai`, `chatgpt` (a ChatGPT sign-in), `google` (Gemini API), `xai`, `mistral`, `groq`, `deepseek`, `cohere`, `perplexity`, `togetherai`, `fireworks`, `cerebras`, `deepinfra`, `baseten`, `huggingface`, `moonshotai`, `zai`, `alibaba`, `minimax`, `bytedance`, `gmicloud` | the API host of each: `api.anthropic.com`, `generativelanguage.googleapis.com`, `router.huggingface.co`…                                                                 |
| `gateway` (Vercel AI Gateway), `openrouter`, `ollama` (Ollama's cloud), `github-copilot`                                                                                                                                                                                                    | `ai-gateway.vercel.sh`, `openrouter.ai`, `ollama.com`, `api.githubcopilot.com`                                                                                           |
| `google-vertex`, `{ region }`: a region, or `global` (the default), `us`, `eu`                                                                                                                                                                                                              | `<region>-aiplatform.googleapis.com`, `aiplatform.googleapis.com` or `aiplatform.<us\|eu>.rep.googleapis.com`, and `oauth2.googleapis.com` for a service account's token |
| `amazon-bedrock`, `{ region }` (required)                                                                                                                                                                                                                                                   | `bedrock-runtime.<region>.amazonaws.com`                                                                                                                                 |
| `azure`, `{ resource }`: your resource, any without it                                                                                                                                                                                                                                      | `<resource>.openai.azure.com`, `<resource>.services.ai.azure.com`                                                                                                        |

A region or a resource is a label of a host name: anything else throws. A provider the package does not know gives none.

### With a workspace and plugins

[`ai-sdk-harness-workspace`](https://ai-sdk-harness.pages.dev/docs/packages/harness-workspace) names the hosts it fetches the repositories from, and [`ai-sdk-harness-plugins`](https://ai-sdk-harness.pages.dev/docs/packages/harness-plugins) those the selected plugins reach from the sandbox. Merge them with the presets:

```ts
import { harnessHosts, networkPolicy, trustedHosts } from 'ai-sdk-harness-network';

const policy = networkPolicy(
  trustedHosts('javascript'),
  harnessHosts('claude-code'),
  await workspace.hosts({ sessionId }), // ['github.com']
  catalog.hosts(selection).sandbox, // ['mcp.example.com', 'registry.npmjs.org']
);
```

The same list goes to every sandbox package, under the name it takes:

| Package                       | Where the hosts go                                                                        |
| ----------------------------- | ----------------------------------------------------------------------------------------- |
| `ai-sdk-sandbox-sbx`          | `networkPolicy` at creation, `setNetworkPolicy()` while it runs                           |
| `ai-sdk-sandbox-microsandbox` | `networkPolicy` at creation                                                               |
| `ai-sdk-sandbox-cloud-run`    | `allowedHosts`, on top of the service's `SANDBOX_ALLOWED_HOSTS`, and `setNetworkPolicy()` |
| `ai-sdk-sandbox-runtime`      | `allowedDomains` at creation (`allowedHosts(...)`), and `setNetworkPolicy()`              |

### Checking hosts

`allowedHosts(...lists)` returns the hosts of the lists, in lower case, each once and sorted; `networkPolicy(...lists)` wraps them in `{ mode: 'custom', allowedHosts }`. Both throw an `InvalidHostError`, which names the host, for one `isAllowedHost(host)` refuses:

- a host name, `api.github.com`, or `*.<domain>` for the subdomains of a domain of two labels at least, `*.githubusercontent.com`;
- no scheme, path nor port: a network policy allows a host on every port;
- never `*` alone nor `*.com`, which would open the whole network.

```ts
import {
  InvalidHostError,
  isAllowedHost,
  networkPolicy,
  trustedHosts,
} from 'ai-sdk-harness-network';

isAllowedHost('*.example.dev'); // true
isAllowedHost('https://example.dev'); // false

try {
  networkPolicy(trustedHosts('javascript'), settings.extraHosts);
} catch (error) {
  if (error instanceof InvalidHostError) console.error(`Not a host: ${error.host}`);
}
```

## Reference

| Export                       | What it is                                                                       |
| ---------------------------- | -------------------------------------------------------------------------------- |
| `networkPolicy(...)`         | `{ mode: 'custom', allowedHosts }` from lists of hosts, checked and merged       |
| `allowedHosts(...)`          | The hosts of lists, checked, in lower case, unique and sorted                    |
| `isAllowedHost(host)`        | Whether a network policy takes `host`                                            |
| `trustedHosts(...)`          | The hosts of services or groups (`TrustedService`, `TrustedGroup`), or of all    |
| `TRUSTED_HOSTS`              | The trusted hosts, by service                                                    |
| `TRUSTED_GROUPS`             | The services of each ecosystem                                                   |
| `harnessHosts(id, options?)` | The hosts of a harness's runtime, by its `harnessId` (`HarnessHostsOptions`)     |
| `HARNESS_NETWORK`            | What each harness the package knows reaches (`KnownHarness`, `HarnessNetwork`)   |
| `providerHosts(provider)`    | The hosts of a model provider's API (`ModelProvider`, `ProviderLocation`)        |
| `PROVIDER_HOSTS`             | The hosts of the providers whose host is the same for everyone (`FixedProvider`) |
| `InvalidHostError`           | Thrown for a host a network policy cannot take; its `host` is the one given      |

## Limitations

- The hosts of each harness belong with its adapter (`@ai-sdk/harness-*`), and those of each provider with its package: none publishes them yet. `HARNESS_NETWORK` and `PROVIDER_HOSTS` stand in for them, and follow the runtimes and the providers as they change.
- `test/presets.e2e-spec.ts` runs real turns of Claude Code and Codex only; the other runtimes' hosts come from their adapters and documentation.
- A registry set in a project's own configuration (`.npmrc`, a mirror, a private index) is not known: add its host. So are Fedora's mirrors, which vary from one download to the next, and Amazon ECR Public, whose layers come from an opaque CloudFront host.
- A wildcard's reach depends on the sandbox: list a domain beside its `*.` wildcard when you need both.

## Development

```bash
pnpm --filter ai-sdk-harness-network test
pnpm --filter ai-sdk-harness-network test:e2e # Docker Sandboxes, Claude Code and Codex credentials
```

## License

MIT
