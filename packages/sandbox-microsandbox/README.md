# ai-sdk-sandbox-microsandbox

<p align="center">
  <a href="https://www.npmjs.com/package/ai-sdk-sandbox-microsandbox"><img alt="npm" src="https://img.shields.io/npm/v/ai-sdk-sandbox-microsandbox" /></a>
  <a href="https://github.com/fpasquet/ai-sdk-harness/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/fpasquet/ai-sdk-harness/actions/workflows/ci.yml/badge.svg" /></a>
  <img alt="Node &gt;= 24" src="https://img.shields.io/badge/node-%3E%3D24-3c873a" />
  <img alt="TypeScript strict" src="https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white" />
  <a href="https://github.com/fpasquet/ai-sdk-harness/blob/main/LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg" /></a>
</p>

Run [AI SDK harness agents](https://ai-sdk.dev/docs/ai-sdk-harnesses/harness-agent) (Claude Code, Codex, OpenCode…) in a [microsandbox](https://github.com/superradcompany/microsandbox): a microVM with a Linux kernel of its own, booted from any OCI image on your machine in a few hundred milliseconds, driven through the `microsandbox` SDK. No daemon, no account.

The package gives `HarnessAgent.createSession({ sandboxSession })` what it expects, a `HarnessV1NetworkSandboxSession`, the same way [`@ai-sdk/sandbox-vercel`](https://www.npmjs.com/package/@ai-sdk/sandbox-vercel) does for Vercel Sandbox:

- **Isolation**: every command and file operation runs in the microVM, hardware-isolated by KVM or Apple's Hypervisor framework. Nothing runs on the host, and nothing of the host is mounted unless you ask for it.
- **Credentials stay out of the sandbox**: the harness hands the sandbox a placeholder; microsandbox's network stack swaps the real value in on the way out, for the API's host only.
- **The harness is installed once**: pass `agent.getSandboxTemplate()` and the first sandbox is saved as a disk snapshot; every later one is restored from it in a fraction of a second.
- **Any image**: `node:24` by default, or the image your project builds with.

> This package is in its **0.x** series: try it, and tell what works and what does not in the [issues](https://github.com/fpasquet/ai-sdk-harness/issues). Until 1.0.0, a minor release may break its API, and its changelog says how; a patch release never does. The AI SDK harnesses it plugs into are themselves experimental, and so is microsandbox. It is a community package, not affiliated with Vercel or with microsandbox.

## How it works

```mermaid
flowchart TB
  subgraph host["Your machine"]
    agent["HarnessAgent"] --> session["createMicrosandboxNetworkSandboxSession()"]
    session -- "microsandbox SDK" --> runtime["microsandbox runtime"]
    net["microsandbox network stack"]
  end
  subgraph vm["microVM"]
    bridge["Harness bridge: Claude Code, Codex"]
  end
  api["Model APIs"]

  runtime --> vm
  agent -. "WebSocket on 127.0.0.1" .-> bridge
  bridge -- "every request" --> net
  net -- "network policy, real credentials put in" --> api
```

Every command and file operation goes to the agent microsandbox runs inside the microVM, and every connection the sandbox opens leaves through microsandbox's network stack on the host, which applies the network policy and puts the credentials in.

## Requirements

- Node.js 24 or later.
- Linux with KVM (your user needs read-write access to `/dev/kvm`), or macOS on Apple Silicon.
- `@ai-sdk/harness` and a harness adapter, such as `@ai-sdk/harness-claude-code`.

The runtime (`msb` and `libkrunfw`) comes with the `microsandbox` npm package this package depends on: nothing else to install. If you also installed the `msb` CLI, its runtime in `~/.microsandbox` takes precedence, and the SDK only launches a runtime of its own version: keep both on the same version (`msb --version`, `msb self update`), or the creation fails with `no tested sandbox launch contract for runtime …`. `msb doctor` checks the host.

## Installation

```bash
pnpm add ai-sdk-sandbox-microsandbox @ai-sdk/harness @ai-sdk/harness-claude-code
```

## Usage

```ts title="agent.ts"
import { HarnessAgent } from '@ai-sdk/harness/agent';
import { createClaudeCode } from '@ai-sdk/harness-claude-code';
import { createMicrosandboxNetworkSandboxSession } from 'ai-sdk-sandbox-microsandbox';

// Authenticated from CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY.
const agent = new HarnessAgent({ id: 'coder', harness: createClaudeCode() });

const sandboxSession = await createMicrosandboxNetworkSandboxSession({
  // The Claude Code bridge listens on the first port; the harness reaches it on the loopback.
  ports: [4000],
  // The bridge installs its dependencies with pnpm, which the node image does not ship.
  setup: ['npm install --global --silent pnpm@10'],
  // Saves Claude Code in a snapshot the first time, restored afterwards.
  template: await agent.getSandboxTemplate(),
});
const session = await agent.createSession({ sandboxSession });

try {
  const result = await agent.generate({
    session,
    prompt: 'Write a script that prints the first ten primes, then run it.',
  });
  console.log(result.text);
} finally {
  await session.destroy();
  await sandboxSession.destroy();
}
```

The caller owns the sandbox: it runs detached, and ending the harness session, or this process, leaves it running. `stop()` stops its microVM and keeps its disk; `destroy()` removes it.

`agent.stream()` works the same way, and its result's `toUIMessageStreamResponse()` feeds `useChat` straight away. The [Next.js example](https://github.com/fpasquet/ai-sdk-harness/tree/main/examples/next-chat) is a complete chat on top of it, with `EXAMPLE_SANDBOX=microsandbox`.

## Images and users

The microVM boots from an OCI image, pulled from its registry the first time and cached afterwards. The default, `node:24`, ships Node.js for the harness and git, curl and Python for the agent. Any image with Node.js does:

```ts
await createMicrosandboxNetworkSandboxSession({
  image: 'ghcr.io/acme/build-image:latest',
  user: 'builder',
  ports: [4000],
});
```

Commands run as `node`, the unprivileged user of the `node` images, or as the image's own user with any other `image`, unless `user` says otherwise. Run the harness as an unprivileged user: Claude Code refuses to skip its permission prompts as `root`. The `setup` commands run as `root`, so they can install what the harness needs.

## Templates

A harness bootstraps itself in the sandbox before its first turn: Claude Code installs `@anthropic-ai/claude-agent-sdk` and the `claude` CLI. Pass the agent's template and it happens once:

```ts
const sandboxSession = await createMicrosandboxNetworkSandboxSession({
  ports: [4000],
  setup: ['npm install --global --silent pnpm@10'],
  template: await agent.getSandboxTemplate(),
});
```

The first call creates a throwaway sandbox, runs `setup` in it, lets the harness prepare it, stops it, saves its disk as a snapshot and removes it. The snapshot is named `ai-sdk-harness-template-<digest>`, the digest covering the harness recipe, the image, the user and the `setup` commands, so a new harness version gets a snapshot of its own. Every later sandbox is restored from it, with its own resources, ports and mounts. A restored sandbox does not intercept TLS until it holds a secret, and a `custom` policy would refuse its HTTPS hosts until then: the package registers one at once, `MICROSANDBOX_TLS_INTERCEPTION`, allowed for no reachable host, which restarts the microVM once. It goes away once microsandbox lets a restore turn interception on ([microsandbox#1836](https://github.com/superradcompany/microsandbox/issues/1836)).

The snapshots stay in microsandbox's store (`msb snapshot ls`), and a harness upgrade leaves the previous one behind. `pruneMicrosandboxTemplates()` removes them, or only those older than `olderThan` milliseconds; the sandboxes restored from them are copies of their own, which keep running and starting, and the next sandbox created from a removed template builds it again:

```ts
import { pruneMicrosandboxTemplates } from 'ai-sdk-sandbox-microsandbox';

// The templates not made in the last week.
const removed = await pruneMicrosandboxTemplates({ olderThan: 7 * 24 * 60 * 60 * 1000 });
```

## Resuming a sandbox

Creation never resumes: a sandbox already named `sandboxId` is a conflict. Name the sandbox, keep its id, and reattach to it, from the same process or another one:

```ts
import {
  createMicrosandboxNetworkSandboxSession,
  MicrosandboxSandboxNotFoundError,
  resumeMicrosandboxNetworkSandboxSession,
} from 'ai-sdk-sandbox-microsandbox';

async function openSandbox() {
  try {
    return await resumeMicrosandboxNetworkSandboxSession({ sandboxId: 'my-agent' });
  } catch (error) {
    if (!(error instanceof MicrosandboxSandboxNotFoundError)) throw error;
    return createMicrosandboxNetworkSandboxSession({ sandboxId: 'my-agent', ports: [4000] });
  }
}
```

A stopped sandbox starts again on resume. microsandbox remembers the ports a sandbox was created with: resuming needs none. A command ends with the process that started it, so nothing a previous run of your application started is left running in the sandbox.

## Working on your files

By default the sandbox mounts nothing of the host: the agent works on the microVM's own disk, in `/workspace`. Mount a directory there to let it work on yours:

```ts
// Read-write: the agent edits the directory itself.
await createMicrosandboxNetworkSandboxSession({ workspace: '/path/to/project', ports: [4000] });
```

The sandbox's working directory (`defaultWorkingDirectory`, under which the harness creates each session's own directory) is `/workspace` either way. A mounted directory keeps the owner it has on the host: give the sandbox's user the right to write in it.

What the agent writes in a mounted `workspace`, your machine may run later: Git hooks, an `.envrc`, the scripts of a `package.json`. Review its changes before running anything from the directory. To let the agent read a directory without changing it, mount it read-only instead, at the same path in the sandbox:

```ts
await createMicrosandboxNetworkSandboxSession({
  readOnlyWorkspaces: ['/path/to/project', '/path/to/docs'],
  ports: [4000],
});
```

Every host directory is mounted `nosuid,nodev`: a setuid binary or a device file in it has no effect in the sandbox.

## Hardening

The microVM is what stands between the agent and your machine: its own kernel, hardware-isolated. Inside it, the package also sets:

- **`security: 'restricted'`**, microsandbox's in-guest profile: the commands run with `no_new_privs` and without the mount-admin capability, so no setuid binary, `sudo` included, makes them root. `security: 'default'` keeps root semantics, for a workload that needs them, such as a Docker daemon.
- **`maxTcpConnections: 1024`**: each open connection of the sandbox costs your machine around 128 KiB of memory, which the cap bounds.
- **`maxDuration` and `idleTimeout`**, unset by default: seconds after which microsandbox stops the sandbox, at all or once idle. Its disk stays, and the next command starts it again.

## Docker

`docker: true` runs a Docker daemon in the sandbox, so the agent can use `docker` and `docker compose`, a project's `compose.yml` included:

```ts
await createMicrosandboxNetworkSandboxSession({
  docker: true, // or { diskSize: 20_480 }, in MiB
  ports: [4000],
  template: await agent.getSandboxTemplate(),
});
```

- **Installed once.** Unless the image ships a daemon, `setup` installs Docker Engine and its Compose plugin with [Docker's own script](https://get.docker.com), as `root`, and the template keeps it. Under a `custom` network policy, list `get.docker.com`, `download.docker.com` and `deb.debian.org` for that, or start from an image that has Docker.
- **A disk of its own.** The daemon keeps its images and containers on an ext4 disk of `diskSize` MiB (10 GiB by default, only what is used is taken), where overlay2 works: the sandbox's own root is an overlay already. A template carries it, each sandbox restored from it getting a copy of its own; the template's name covers its size.
- **Started with the sandbox.** The daemon runs as a job of microsandbox, which outlives your process; it is started again whenever the sandbox starts, after a `stop()` or a restart. Its log is `/var/log/dockerd.log`. A container without a `restart` policy stays stopped when its daemon starts again, as anywhere with Docker.
- **The sandbox's user owns its socket**, through its group: no `sudo`. Docker needs root semantics, so `security` is `default` (`restricted` is refused), and `memory` defaults to 4096 MiB.
- **Docker Hub is reachable** under a `custom` policy, its registry, token service and CDNs added to the listed hosts. List any other registry yourself.

The containers go out through the sandbox's network stack: its policy applies to them, and they reach neither your machine nor its private networks. microsandbox inspects their HTTPS with its own certificate authority, which the sandbox trusts but a container does not: mount the sandbox's bundle into it, and point the tools that keep their own list at it. The sandbox's `description` says so, for the tools that read it; a harness agent does not, so tell it in its `instructions`, or it may well turn TLS verification off instead:

```ts
const agent = new HarnessAgent({
  id: 'coder',
  harness: createClaudeCode(),
  instructions:
    'For HTTPS from a container, mount /etc/ssl/certs/ca-certificates.crt read-only at the same ' +
    'path in it, and set NODE_EXTRA_CA_CERTS, SSL_CERT_FILE and CURL_CA_BUNDLE to that path. ' +
    'Never turn TLS verification off.',
});
```

```yaml title="compose.yml"
services:
  app:
    image: node:24
    volumes:
      - /etc/ssl/certs/ca-certificates.crt:/etc/ssl/certs/ca-certificates.crt:ro
    environment:
      NODE_EXTRA_CA_CERTS: /etc/ssl/certs/ca-certificates.crt
```

## Credentials

A harness that supports credential brokering never puts the real credential in the sandbox. It hands the sandbox a random placeholder, an `aisdkhc_…` string, and asks the sandbox session to transform the requests on their way out. This package turns each transformation into a microsandbox secret, allowed for the API's host only: microsandbox's network stack, outside the microVM, then puts the real value in the requests to that host. The agent can use the credential to call its API; it cannot read it.

```mermaid
sequenceDiagram
  autonumber
  participant App as Your application
  participant Msb as microsandbox, on the host
  participant Sandbox as microVM
  participant API as api.anthropic.com

  App->>App: Makes a random placeholder, aisdkhc_…
  App->>Msb: Secret: placeholder to real value, for api.anthropic.com only
  App->>Sandbox: Starts the agent with ANTHROPIC_API_KEY=aisdkhc_…
  Sandbox->>Msb: HTTPS request to api.anthropic.com carrying the placeholder
  Msb->>API: Same request, the real value in place of the placeholder
  API-->>Sandbox: Answer, without the credential
```

| Harness and sign-in                                                             | What the sandbox sees               | What microsandbox is given                                  |
| ------------------------------------------------------------------------------- | ----------------------------------- | ----------------------------------------------------------- |
| Claude Code, API key (`ANTHROPIC_API_KEY`)                                      | `ANTHROPIC_API_KEY=aisdkhc_…`       | The key, for `api.anthropic.com`                            |
| Claude Code, Claude subscription (`CLAUDE_CODE_OAUTH_TOKEN`, or `claude` login) | `CLAUDE_CODE_OAUTH_TOKEN=aisdkhc_…` | The access token alone: the refresh token stays on the host |
| Codex, API key (`OPENAI_API_KEY`)                                               | `CODEX_API_KEY=aisdkhc_…`           | The key, for `api.openai.com`                               |
| Codex, ChatGPT subscription (`codex` login)                                     | `CODEX_API_KEY=aisdkhc_…`           | The access token, for `chatgpt.com`                         |

To put a secret in an HTTPS request, microsandbox intercepts TLS: every sandbox this package creates trusts microsandbox's own certificate authority, through the system store and `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE` and `REQUESTS_CA_BUNDLE`. A tool that ships its own list of authorities and ignores those cannot reach HTTPS hosts. With Codex logged in with ChatGPT, the harness asks for a `ChatGPT-Account-ID` header microsandbox cannot add, since it only swaps placeholders: it is left out with a warning, and Codex works without it.

Where the real value lives:

- **On the host**, where your application reads it, and **in microsandbox's database** (`~/.microsandbox/db`, or `$MSB_HOME/db`), readable by your user, from which its network stack reads the secrets of a sandbox. Removing the secret, or the sandbox, deletes its row; SQLite may keep the bytes in its file until the space is reused. Run the application under a user of its own, on a host of its own. Values resolved at runtime and never stored are [microsandbox#1183](https://github.com/superradcompany/microsandbox/issues/1183).
- **Never in the sandbox**, its disk or its template. The sandbox sees the placeholder, in the variable the harness sets and in one microsandbox adds, named `AISDK_<HOST>_<HEADER>`.

A secret with a new placeholder restarts the microVM, in well under a second, since microsandbox cannot hand one to the processes already running. The harness adds its credentials before it starts its bridge, and keeps the same placeholders when a session resumes, which only rotates the values, live. The secrets are withdrawn by `release()` and `stop()`, and removed with the sandbox by `destroy()`.

Brokering can be turned off with `brokerCredentials: false`: the harness then forwards the **real credential** into the sandbox environment, where the agent can read it. Keep it on.

Variables a command does set travel to the sandbox with the command, on microsandbox's own channel: they never appear on a command line, nor in microsandbox's logs.

## Network

Without a `networkPolicy`, microsandbox's default applies: the sandbox reaches the public internet, but no private, loopback or link-local address of the host's networks. Restrict it at creation with the harness's own policy type:

```ts
await createMicrosandboxNetworkSandboxSession({
  ports: [4000],
  networkPolicy: {
    mode: 'custom',
    allowedHosts: ['api.anthropic.com', 'registry.npmjs.org', '*.github.com'],
    deniedCIDRs: ['169.254.169.254/32'],
  },
});
```

`custom` allows the listed hosts and blocks only, a `*.example.com` entry standing for the domain and its subdomains, and `deniedCIDRs` win over everything. `deny-all` blocks every connection out of the sandbox. `allow-all` allows the public internet, like the default: never this host's own services, its private networks or the cloud metadata server. To reach a private address, list its block in a `custom` policy's `allowedCIDRs`. Hosts are matched on the name the sandbox asks for, through microsandbox's DNS and TLS interception: list the model API and every registry the harness and the agent need. The policy is fixed at creation: `setNetworkPolicy` is not implemented, which the harness treats as optional.

## Ports

`ports` lists the ports inside the sandbox the harness may reach. microsandbox publishes them when it creates the sandbox, each on a free port of this host's loopback (`127.0.0.1:<free port>`), and never on another interface. `getPortEndpoint()` resolves them; `setPorts()` can narrow them, but a port the sandbox was not created with is refused with `HarnessCapabilityUnsupportedError`, like any port outside the list.

## Lifecycle

| Method               | What it does                                                                          |
| -------------------- | ------------------------------------------------------------------------------------- |
| `release()`          | Stops the processes this session started and withdraws its secrets                    |
| `killAllProcesses()` | Stops every process started through this session or its restricted views              |
| `stop()`             | `release()`, then stops the microVM. Its disk stays; the next command starts it again |
| `destroy()`          | Removes the sandbox, its disk and its secrets                                         |
| `restricted()`       | The files-and-processes view of the same sandbox, to hand to tools (see below)        |

`restricted()` returns an `Experimental_SandboxSession`: it can run commands and read and write files, but cannot stop the sandbox or touch credentials. Pass it to AI SDK tools that accept `experimental_sandbox`.

microsandbox keeps what the commands print in `exec.log`, next to the sandbox's disk (`msb logs <id>`), until the sandbox is removed.

## Options

`createMicrosandboxNetworkSandboxSession(options)` takes every option below; `resumeMicrosandboxNetworkSandboxSession(options)` takes `sandboxId`, `abortSignal` and `brokerCredentials`.

| Option               | Default                                   | Description                                                                                     |
| -------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `sandboxId`          | `ai-sdk-<hex>`                            | The sandbox's name in `msb ls`. Creation fails if it is taken                                   |
| `template`           | none                                      | `await agent.getSandboxTemplate()`: prepare once, restore every later sandbox from the snapshot |
| `abortSignal`        | none                                      | Aborts the creation or the resume                                                               |
| `image`              | `'node:24'`                               | The OCI image the microVM boots from                                                            |
| `user`               | `'node'`, or the image's                  | Who the commands run as, but `setup`                                                            |
| `ports`              | `[]`                                      | Ports the harness may reach, published on the loopback at creation                              |
| `cpus`               | `2`                                       | vCPUs of the microVM                                                                            |
| `memory`             | `2048`, `4096` with `docker`              | Memory of the microVM, in MiB                                                                   |
| `workspace`          | none                                      | Host directory to mount read-write at `/workspace`, the working directory                       |
| `readOnlyWorkspaces` | `[]`                                      | Host directories to mount read-only, each at its own path                                       |
| `security`           | `'restricted'`, `'default'` with `docker` | In-guest security profile: `restricted` or `default` (root semantics)                           |
| `maxDuration`        | none                                      | Seconds after which the sandbox is stopped                                                      |
| `idleTimeout`        | none                                      | Seconds of inactivity after which the sandbox is stopped                                        |
| `maxTcpConnections`  | `1024`                                    | Connections the sandbox may hold open at once                                                   |
| `docker`             | `false`                                   | Run a Docker daemon: `true`, or `{ diskSize }` in MiB (10240 by default)                        |
| `networkPolicy`      | public internet only                      | What the sandbox may reach: `allow-all`, `deny-all` or `custom`                                 |
| `setup`              | `[]`                                      | Commands run once after creation, as `root`, baked into the template                            |
| `brokerCredentials`  | `true`                                    | _Connection._ Keep credentials out of the sandbox, put in by microsandbox's network stack       |

## Errors

- `MicrosandboxSandboxNotFoundError`: `resumeMicrosandboxNetworkSandboxSession()` found no sandbox of that name. Carries `sandboxId`.
- `MicrosandboxCommandError`: a `setup` command, or a step of the creation, exited with a non-zero status. Carries `command`, `exitCode` and `stderr`. The half-made sandbox is removed.
- `HarnessCapabilityUnsupportedError` (from `@ai-sdk/harness`): a port that is not exposed, or a credential microsandbox cannot broker.
- The errors of the `microsandbox` SDK (`MicrosandboxError` and its subclasses) come through as they are: a missing runtime, a host without KVM, an image that cannot be pulled.

## Security checklist

What the sandbox does, or does not, against the essential risks of running an agent's code: ✅ covered, ⚠️ partly or with care, ❌ not covered. The same table describes every sandbox package of this repository. The rest is your application's and the harness's: approving sensitive actions, budgets, audit, and reviewing what leaves the sandbox before it runs anywhere else.

| Control                        | Status | How                                                                                                                                                                                    |
| ------------------------------ | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Isolation boundary             | ✅     | A microVM with a kernel of its own, behind KVM or Hypervisor.framework                                                                                                                 |
| Nothing of the host by default | ✅     | Nothing mounted but `workspace` and `readOnlyWorkspaces`; no access to the host's Docker                                                                                               |
| Writes to the host             | ⚠️     | `workspace` is read-write: review what the agent writes there. `readOnlyWorkspaces` are read-only; every mount is `nosuid,nodev`                                                       |
| Privileges                     | ✅     | `restricted` profile by default: no setuid way to root. With `docker`, root stays inside the microVM                                                                                   |
| Docker and Compose             | ✅     | `docker: true`: a daemon of the sandbox's own, its data on a disk of its own                                                                                                           |
| Outbound allow list            | ⚠️     | `networkPolicy`, applied outside the microVM by microsandbox's network stack, but fixed at creation ([microsandbox#1538](https://github.com/superradcompany/microsandbox/issues/1538)) |
| Private networks and metadata  | ✅     | Unreachable by default and with `allow-all`, from the sandbox and its containers                                                                                                       |
| Inbound ports                  | ⚠️     | Declared `ports` only, on the host's loopback: any local process can connect ([microsandbox#1837](https://github.com/superradcompany/microsandbox/issues/1837))                        |
| Credentials out of the sandbox | ⚠️     | The sandbox holds a placeholder; the real value is stored in microsandbox's database on the host ([microsandbox#1183](https://github.com/superradcompany/microsandbox/issues/1183))    |
| Credential scope               | ⚠️     | Only to its API's host, but in any header that carries the placeholder ([microsandbox#1835](https://github.com/superradcompany/microsandbox/issues/1835))                              |
| Environment                    | ✅     | Only the variables a command names                                                                                                                                                     |
| Resource limits                | ✅     | `cpus`, `memory`, `maxTcpConnections` (1024 by default)                                                                                                                                |
| Lifetime limits                | ✅     | `maxDuration` and `idleTimeout`, opt-in                                                                                                                                                |
| Teardown                       | ✅     | `destroy()` removes the microVM, its disks and its secrets                                                                                                                             |

## Limitations

- **Ports are published on the host's loopback.** Any process of this host can connect to them, and microsandbox's `multi-tenant` profile, which turns published ports off, cannot be used: the harness reaches its bridge through one ([microsandbox#1837](https://github.com/superradcompany/microsandbox/issues/1837)).
- **One bridge per port.** A bridge-backed harness listens on the first port: run one harness session at a time per sandbox, or give each its own port.
- **Ports and the network policy are fixed at creation.** microsandbox cannot change the policy of an existing sandbox ([microsandbox#1538](https://github.com/superradcompany/microsandbox/issues/1538)), and its Node.js SDK cannot publish a port on one yet ([microsandbox#1780](https://github.com/superradcompany/microsandbox/issues/1780)).
- **A secret is put in any header that carries its placeholder.** microsandbox can restrict a secret to the credential's own header, but not one added to a running sandbox, as the harness's are ([microsandbox#1835](https://github.com/superradcompany/microsandbox/issues/1835)). An allowed API that echoes the request's headers back could hand the real value to the sandbox.

## Development

This package lives in the [`ai-sdk-harness`](https://github.com/fpasquet/ai-sdk-harness) monorepo. `pnpm test` runs the unit tests against a fake `microsandbox` SDK that runs commands on the host; `pnpm test:e2e` runs them against the real runtime, creating and removing microVMs on your machine.

## License

[MIT](https://github.com/fpasquet/ai-sdk-harness/blob/main/LICENSE)
