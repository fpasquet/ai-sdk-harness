# Network

Each host the sandbox can reach is a way for code, or the project's secrets, to leave it. Propose a closed policy: the hosts the harness needs, the registries of the project, and the user's own hosts. `ai-sdk-harness-network` lists them; it has no dependency and runs anywhere.

```bash
<pm> add ai-sdk-harness-network
```

## Build the list

```ts
import { allowedHosts, harnessHosts, networkPolicy, trustedHosts } from 'ai-sdk-harness-network';

const policy = networkPolicy(
  harnessHosts('claude-code'), // registry.npmjs.org, api.anthropic.com
  trustedHosts('github', 'javascript'), // the forge and the registries the project uses
  ['api.acme.dev'], // the user's own
);
// { mode: 'custom', allowedHosts: [...] }
```

- `harnessHosts(harnessId)` takes the `harnessId` of the adapter (`'claude-code'`, `'codex'`, `'opencode'`…): where it installs from, its service, and its provider's API. `{ provider: 'gateway' }` or `{ provider: 'amazon-bedrock', region }` when the model goes through another provider; `install: false` once the runtime is in the template. OpenCode has no provider of its own: always name one (`harnessHosts('opencode', { provider: 'openrouter' })`), or its model's API is missing from the list. Pi and fx run on the app's server and give none: their sandbox only needs the project's registries.
- `trustedHosts(...)` takes services (`'github'`, `'npm'`, `'pypi'`, `'crates'`, `'go'`, `'docker-hub'`…) or groups (`'forges'`, `'javascript'`, `'python'`, `'rust'`, `'jvm'`, `'dotnet'`, `'containers'`, `'linux'`, `'infrastructure'`). Map them from the introspection: `package.json` → `'javascript'`, `pyproject.toml` → `'python'`, `go.mod` → `'go'`, `Cargo.toml` → `'rust'`, a remote on GitHub → `'github'`, `docker compose` in the tests → `'containers'`.
- **Open what the project uses, not every group.** Some services share hosts with everyone (`storage.googleapis.com` for Go, `*.pkg.dev`): name the services rather than the groups when that matters, and tell the user.
- `networkPolicy(...)` gives `{ mode: 'custom', allowedHosts }` for the packages that take a policy; `allowedHosts(...)` the bare list, for those that take hosts (table below). Both throw an `InvalidHostError` on a host they refuse: a scheme, a path, a port, `*` alone or `*.com`.

With `ai-sdk-harness-workspace` and `ai-sdk-harness-plugins`, merge their hosts too: `await workspace.hosts({ sessionId })`, `catalog.hosts(selection).sandbox`.

## Where the list goes

| Package                       | Option                                                                                                                                 |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `ai-sdk-sandbox-sbx`          | `networkPolicy: policy` at creation, local sandboxes only; `setNetworkPolicy()` while it runs                                          |
| `ai-sdk-sandbox-microsandbox` | `networkPolicy: policy` at creation, fixed afterwards                                                                                  |
| `ai-sdk-sandbox-runtime`      | `allowedDomains: allowedHosts(...)` at creation; `setNetworkPolicy()` while it runs                                                    |
| `ai-sdk-sandbox-cloud-run`    | `allowedHosts: allowedHosts(...)`, on top of the service's `SANDBOX_ALLOWED_HOSTS`, at each resume; `setNetworkPolicy()` while it runs |
| `ai-sdk-sandbox-gce`          | `allowedHosts: allowedHosts(...)`, on top of the service's `SANDBOX_ALLOWED_HOSTS`, at each resume; `setNetworkPolicy()` while it runs |

```ts
// ai-sdk-sandbox-sbx (and microsandbox): the policy, at creation.
await createSbxNetworkSandboxSession({ ...settings, networkPolicy: policy, template });

// ai-sdk-sandbox-cloud-run and -gce: the hosts, in the settings passed on create and on every resume.
const settings = {
  url,
  ports: [4000],
  allowedHosts: allowedHosts(harnessHosts('claude-code'), trustedHosts('github')),
};
```

In Docker Sandboxes Cloud, the account's policy and `allowNetwork` decide instead. Cloud Run and Compute Engine reach nothing but the service's hosts and the ones given: the model's API goes through the service's base URLs, so `harnessHosts()` there mostly adds the install registry.

## The template is built under the same network

`getSandboxTemplate()` prepares a throwaway sandbox under the network of the sandbox it is for, then saves it. What the sandbox could not reach, its template build cannot either: the hosts of `setup` (npm for pnpm, the toolchain's installer) and the harness's install must be in the list. A build that fails names the hosts the network refused: add the ones the project needs, never `allow-all`.

## Credentials and the network

Credential brokering swaps the real value in outside the sandbox, on the way to the provider's host: keep that host in the list (`harnessHosts()` has it). Never pass a real credential into the sandbox's environment, or turn brokering off, to get around a refused host.
