# Sandboxes

Every sandbox package gives `agent.createSession({ sandboxSession })` the same thing, a `HarnessV1NetworkSandboxSession`: the harness and the user's tools never know which one runs. Pick by where the agent runs and what its project needs.

| Package                       | Where                                | Isolation             | Docker in it        | Image                                    | Needs first                                             |
| ----------------------------- | ------------------------------------ | --------------------- | ------------------- | ---------------------------------------- | ------------------------------------------------------- |
| `ai-sdk-sandbox-sbx`          | This host, or Docker Sandboxes Cloud | A microVM             | Yes                 | `image` per sandbox                      | Docker Sandboxes installed, `sbx login`                 |
| `ai-sdk-sandbox-microsandbox` | This host                            | A microVM             | Yes, `docker: true` | Any OCI image (`node:24` by default)     | Linux with KVM, or macOS on Apple Silicon               |
| `ai-sdk-sandbox-runtime`      | This host                            | srt: processes fenced | No                  | None: the host's own tools               | Linux (`bubblewrap`, `socat`, `ripgrep`) or macOS, pnpm |
| `ai-sdk-sandbox-cloud-run`    | Google Cloud, Cloud Run              | gVisor                | No                  | The service's, one for all its sandboxes | Its sandbox service deployed (README)                   |
| `ai-sdk-sandbox-gce`          | Google Cloud, Compute Engine         | A virtual machine     | Yes                 | Among those the service offers           | Its service, proxy and images deployed (README)         |

## Signals for the recommendation

- `sbx version` answers → `sbx`: the docs, the starter and the examples use it.
- No Docker Sandboxes, but `/dev/kvm` is usable or the Mac is Apple Silicon → `microsandbox`: nothing else to install, the runtime comes with the npm package.
- Neither, and the project needs no containers → `runtime` (srt). It fences the agent's processes on the host rather than isolating a machine: say so.
- The agent runs on a server on Google Cloud → `cloud-run` when it edits code and runs plain processes (scaled to zero, cheap), `gce` when its tests need `docker compose`, a database, or a machine of their own.
- Another cloud, or none of these fits → say so. Every package implements the same interface, so the rest of the setup does not change with the sandbox.

## The sandbox of each package

Every sandbox of the Claude Code harness needs:

- `ports: [4000]`: its bridge listens there, inside the sandbox.
- `template: await agent.getSandboxTemplate()`: the harness installs its runtime once, in an image or snapshot every later sandbox starts from. The first creation takes a minute or two.
- pnpm, with which the Claude Code bridge installs its dependencies: `setup: ['npm install --global --silent pnpm@10']` on `sbx` and `microsandbox`; on the host's `PATH` for `runtime`; already in the Cloud Run and Compute Engine images.
- Node.js and git in any image of the user's, beside the project's toolchain: the bridge runs on Node.js, and `ai-sdk-harness-workspace` fetches repositories with git.

Name the sandbox (`sandboxId`), and **resume it** on the next run rather than creating one each time: creation never resumes, an existing name is a conflict.

### `ai-sdk-sandbox-sbx`

```ts
import { HarnessAgent } from '@ai-sdk/harness/agent';
import { createClaudeCode } from '@ai-sdk/harness-claude-code';
import {
  createSbxNetworkSandboxSession,
  resumeSbxNetworkSandboxSession,
  SbxSandboxNotFoundError,
} from 'ai-sdk-sandbox-sbx';

export const agent = new HarnessAgent({ harness: createClaudeCode() });

export async function openSandbox() {
  const settings = { sandboxId: 'my-agent', ports: [4000] };
  try {
    const sandbox = await resumeSbxNetworkSandboxSession(settings);
    // A previous run may have left its bridge behind, holding the port.
    await sandbox.killAllProcesses();
    return sandbox;
  } catch (error) {
    if (!(error instanceof SbxSandboxNotFoundError)) throw error;
  }
  return createSbxNetworkSandboxSession({
    ...settings,
    setup: ['npm install --global --silent pnpm@10'],
    template: await agent.getSandboxTemplate(),
  });
}
```

Options worth asking about: `workspace` (a host directory mounted read-write; `clone: true` for a private clone of a Git repository whose commits come back through a `sandbox-<name>` remote), `image`, `networkPolicy`. `stop()` keeps the files, `destroy()` removes the sandbox.

### `ai-sdk-sandbox-microsandbox`

The same shape: `createMicrosandboxNetworkSandboxSession()`, `resumeMicrosandboxNetworkSandboxSession()`, `MicrosandboxSandboxNotFoundError`, with `setup: ['npm install --global --silent pnpm@10']`. Its `image` is any OCI image (`node:24` by default), `docker: true` runs a Docker daemon in it, and `networkPolicy` is **fixed at creation**. It has no `fork()`: with `ai-sdk-harness-sessions`, only `sandboxPerSession()`.

If the user also installed the `msb` CLI, its runtime must be the version of the npm package (`msb --version`): `msb doctor` checks the host.

### `ai-sdk-sandbox-runtime`

`createSrtNetworkSandboxSession()`, `resumeSrtNetworkSandboxSession()`, `SrtSandboxNotFoundError`. No image: the agent uses the host's tools, in a directory of its own or the `workspace` given. Its network is `allowedDomains` at creation, srt's syntax, by default `registry.npmjs.org`, `api.anthropic.com`, `api.openai.com`, `chatgpt.com` and `ai-gateway.vercel.sh`.

On Linux, srt needs `bubblewrap`, `socat` and `ripgrep` (`sudo apt install bubblewrap socat ripgrep`). Recent Ubuntu releases refuse its seccomp filter (`apply-seccomp: … Permission denied`): the package's README gives the two ways out, read it rather than guessing.

### `ai-sdk-sandbox-cloud-run`

```ts
import {
  CloudRunSandboxNotFoundError,
  createCloudRunNetworkSandboxSession,
  resumeCloudRunNetworkSandboxSession,
} from 'ai-sdk-sandbox-cloud-run';

const settings = {
  sandboxId: 'my-agent',
  url: process.env.CLOUD_RUN_SANDBOX_URL!,
  serviceToken: process.env.CLOUD_RUN_SANDBOX_SERVICE_TOKEN,
  // 'gcloud' by default, on a developer's machine; the workload's service account on Google Cloud.
  auth: 'metadata' as const,
  ports: [4000],
  // The bridge installs its dependencies from npm.
  allowedHosts: ['registry.npmjs.org'],
};
```

`createCloudRunNetworkSandboxSession({ ...settings, template })` the first time, `resumeCloudRunNetworkSandboxSession(settings)` after. The service keeps neither `ports` nor `allowedHosts` across a suspension: pass the same settings on every resume. The sandbox service is deployed first, from the package's README (image, bucket, service account, `gcloud run deploy`), with the image pinned to the version of the package the app depends on.

### `ai-sdk-sandbox-gce`

```ts
import {
  createGceNetworkSandboxSession,
  GceSandboxNotFoundError,
  resumeGceNetworkSandboxSession,
} from 'ai-sdk-sandbox-gce';

const settings = {
  sandboxId: 'my-agent',
  url: process.env.GCE_SANDBOX_URL!,
  serviceToken: process.env.GCE_SANDBOX_SERVICE_TOKEN,
  auth: 'metadata' as const,
  ports: [4000],
  allowedHosts: ['registry.npmjs.org'],
};
```

Then as on Cloud Run: `createGceNetworkSandboxSession({ ...settings, template })` the first time, `resumeGceNetworkSandboxSession(settings)` after, with the same settings on every resume. `image` names one of the images the service offers (`SANDBOX_IMAGES`), for a project in another language. A stopped sandbox keeps its disk; a resume boots the machine again. Its deployment is longer (a VPC, an egress proxy, images, the service): follow its README step by step, with the user.

## Next.js

The harnesses read their bridge from files next to their module, which a bundle would leave behind. List every harness and sandbox package the app imports in `next.config.*`:

```ts
const config: NextConfig = {
  serverExternalPackages: [
    '@ai-sdk/harness',
    '@ai-sdk/harness-claude-code',
    'ai-sdk-sandbox-sbx',
    // and, when used: 'ai-sdk-harness-sessions', 'ai-sdk-harness-workspace',
    // 'ai-sdk-sandbox-microsandbox' with 'microsandbox',
    // 'ai-sdk-sandbox-runtime' with '@anthropic-ai/sandbox-runtime'
  ],
};
```

The agent and its sandbox live on the server only: a route handler or a server action, never a client component.
