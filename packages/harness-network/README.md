# ai-sdk-harness-network

<p align="center">
  <a href="https://www.npmjs.com/package/ai-sdk-harness-network"><img alt="npm" src="https://img.shields.io/npm/v/ai-sdk-harness-network" /></a>
  <a href="https://github.com/fpasquet/ai-sdk-harness/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/fpasquet/ai-sdk-harness/actions/workflows/ci.yml/badge.svg" /></a>
  <img alt="Node &gt;= 24" src="https://img.shields.io/badge/node-%3E%3D24-3c873a" />
  <img alt="TypeScript strict" src="https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white" />
  <a href="https://github.com/fpasquet/ai-sdk-harness/blob/main/LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg" /></a>
</p>

The hosts the sandbox of an [AI SDK harness agent](https://ai-sdk.dev/docs/ai-sdk-harnesses/harness-agent) may reach, so that its network can be **closed to everything else**: trusted lists for GitHub, npm, Yarn and PyPI, the hosts Claude Code and Codex call, and the functions that check and merge them — with those of a workspace and of plugins — into the network policy every sandbox package takes.

## At a glance

A coding agent needs few hosts: its model's API, the registry its runtime installs from, the forge of its repository, the registries of the project's packages. Every sandbox package takes them as `allowedHosts` and lets nothing else through; every application ends up writing the same list. This package writes it once:

```ts
import { harnessHosts, networkPolicy, trustedHosts } from 'ai-sdk-harness-network';
import { createSbxNetworkSandboxSession } from 'ai-sdk-sandbox-sbx';

const sandboxSession = await createSbxNetworkSandboxSession({
  ports: [4000],
  networkPolicy: networkPolicy(
    trustedHosts('github', 'npm'), // github.com, api.github.com, codeload.github.com, *.githubusercontent.com, registry.npmjs.org
    harnessHosts(harness.harnessId), // api.anthropic.com for Claude Code
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
| `pip install requests`                      | Refused: PyPI was not listed (`trustedHosts('pypi')`)        |

## Installation

```bash
pnpm add ai-sdk-harness-network
```

No dependency, peer or runtime: it is lists of hosts and the functions that check them. It runs in the browser too, where a settings form checks the hosts a user types as your server does.

## Usage

### Trusted hosts

`trustedHosts(...services)` gives the hosts of the services named, every service without any; `TRUSTED_HOSTS` holds them:

| Service  | Hosts                                                                            | What goes through                                                      |
| -------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `github` | `github.com`, `api.github.com`, `codeload.github.com`, `*.githubusercontent.com` | Git over HTTPS, the REST API, archives, raw files, releases and LFS    |
| `npm`    | `registry.npmjs.org`                                                             | npm, pnpm and Bun installs, and the harnesses installing their runtime |
| `yarn`   | `registry.yarnpkg.com`, `repo.yarnpkg.com`                                       | Yarn installs, and the releases of Yarn that Corepack downloads        |
| `pypi`   | `pypi.org`, `files.pythonhosted.org`                                             | pip, uv and pipx installs                                              |

Each list names every host it relies on, the domain beside its wildcard: whether `*.example.com` covers `example.com` itself differs from one sandbox to another (microsandbox's does, srt's does not).

### The harness's own hosts

`harnessHosts(harnessId)` gives the hosts the harness's runtime calls from the sandbox, by the `harnessId` of its adapter; none for a harness the package does not know, whose hosts are yours to list. `HARNESS_HOSTS` holds them:

| Harness       | Hosts                                              |
| ------------- | -------------------------------------------------- |
| `claude-code` | `api.anthropic.com`                                |
| `codex`       | `api.openai.com`, `auth.openai.com`, `chatgpt.com` |

With the npm registry, where the harness installs its runtime when the sandbox has no template yet, they are enough for a turn: `test/presets.e2e-spec.ts` runs one of each runtime in a Docker Sandbox closed to everything else. Codex calls `api.openai.com` with an API key, and `chatgpt.com` with a ChatGPT sign-in, whose token it refreshes at `auth.openai.com`. A runtime that calls a model through a gateway of yours (`baseURL`) needs that gateway's host instead.

### With a workspace and plugins

[`ai-sdk-harness-workspace`](https://ai-sdk-harness.pages.dev/docs/packages/harness-workspace) names the hosts it fetches the repositories from, and [`ai-sdk-harness-plugins`](https://ai-sdk-harness.pages.dev/docs/packages/harness-plugins) those the selected plugins reach from the sandbox. Merge them with the presets:

```ts
import { harnessHosts, networkPolicy, trustedHosts } from 'ai-sdk-harness-network';

const policy = networkPolicy(
  trustedHosts('npm'),
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
  networkPolicy(trustedHosts('npm'), settings.extraHosts);
} catch (error) {
  if (error instanceof InvalidHostError) console.error(`Not a host: ${error.host}`);
}
```

## Reference

| Export                | What it is                                                                  |
| --------------------- | --------------------------------------------------------------------------- |
| `networkPolicy(...)`  | `{ mode: 'custom', allowedHosts }` from lists of hosts, checked and merged  |
| `allowedHosts(...)`   | The hosts of lists, checked, in lower case, unique and sorted               |
| `isAllowedHost(host)` | Whether a network policy takes `host`                                       |
| `trustedHosts(...)`   | The hosts of `github`, `npm`, `yarn`, `pypi`, or of all                     |
| `TRUSTED_HOSTS`       | The trusted hosts, by service (`TrustedService`)                            |
| `harnessHosts(id)`    | The hosts of a harness's runtime, by its `harnessId`                        |
| `HARNESS_HOSTS`       | The hosts of each harness the package knows (`KnownHarness`)                |
| `InvalidHostError`    | Thrown for a host a network policy cannot take; its `host` is the one given |

## Limitations

- The hosts of each harness belong with its adapter (`@ai-sdk/harness-claude-code`, `@ai-sdk/harness-codex`), which does not publish them yet: `HARNESS_HOSTS` stands in for them, and follows the runtimes as they change.
- A registry set in a project's own configuration (`.npmrc`, a mirror, a private index) is not known: add its host.
- A wildcard's reach depends on the sandbox: list a domain beside its `*.` wildcard when you need both.

## Development

```bash
pnpm --filter ai-sdk-harness-network test
pnpm --filter ai-sdk-harness-network test:e2e # Docker Sandboxes, Claude Code and Codex credentials
```

## License

MIT
