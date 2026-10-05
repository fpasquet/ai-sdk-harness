import type {
  HarnessV1SandboxSessionCreateOptions,
  HarnessV1SandboxSessionResumeOptions,
} from '@ai-sdk/harness';

/** How this process talks to a sandbox, the same whether the sandbox was just created or resumed. */
export interface SbxConnectionSettings {
  /**
   * Run in [Docker Sandboxes Cloud](https://docs.docker.com/ai/sandboxes/) rather than on this
   * host: every `sbx` command goes out as `sbx --cloud …`. Needs a Docker Agentic Platform
   * subscription and `sbx login`. Experimental: it may change in a minor release while it settles.
   *
   * @defaultValue `false`
   */
  cloud?: boolean;
  /**
   * Ports inside the sandbox the harness may reach. Each is published the first time it is asked
   * for: on this host's loopback for a local sandbox, at a public URL the control plane assigns for
   * a cloud one. Bridge-backed harnesses (Claude Code, Codex…) listen on the first.
   *
   * @defaultValue `[]`
   */
  ports?: readonly number[];
  /**
   * Keep credentials out of the sandbox: the Docker Sandboxes proxy puts the real value in the
   * requests on their way out (`sbx secret set-custom`). Turn it off
   * only for an `sbx` without custom secrets: the harness then forwards the real credential into
   * the sandbox environment.
   *
   * @defaultValue `true`
   */
  brokerCredentials?: boolean;
  /**
   * Variables of the sandbox's own environment to drop from every command that does not set them
   * itself, on top of the `proxy-managed` ones (see {@link keepProxyManagedEnv}).
   *
   * @defaultValue `[]`
   */
  clearEnv?: readonly string[];
  /**
   * Docker Sandboxes pre-sets credential variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
   * `GH_TOKEN`…) to a `proxy-managed` placeholder for its own credential store. Left in place, one
   * can take precedence over the credential a harness does pass (the `claude` CLI prefers
   * `ANTHROPIC_API_KEY` to `CLAUDE_CODE_OAUTH_TOKEN`), so every `*_API_KEY` and `*_TOKEN` variable
   * holding such a placeholder is dropped from the commands that do not set it. Set this to keep
   * them, when you rely on `sbx secret set` instead.
   *
   * @defaultValue `false`
   */
  keepProxyManagedEnv?: boolean;
  /**
   * The `sbx` binary.
   *
   * @defaultValue `'sbx'`, looked up on the `PATH`
   */
  binary?: string;
}

/** What a new sandbox is made of. Fixed at creation: `sbx` cannot change it afterwards. */
export interface SbxCreationSettings extends SbxConnectionSettings {
  /**
   * The Docker Sandboxes agent kit the sandbox is made from: its image and network rules. `shell`
   * is a plain Linux userland with Node.js and git; the harness installs its own runtime in it.
   *
   * @defaultValue `'shell'`
   */
  agent?: string;
  /** Container image to use instead of the kit's own (`sbx create --template`). */
  image?: string;
  /**
   * A directory of this host the sandbox works in, bind-mounted read-write: the agent edits your
   * files. Without it the sandbox mounts nothing of the host and works on its own filesystem.
   * Local sandboxes only.
   */
  workspace?: string;
  /**
   * With {@link workspace} set to a Git repository: give the sandbox a private clone of it instead
   * of the directory itself (`sbx create --clone`). The host repository is only mounted read-only,
   * and the agent's commits come back through the `sandbox-<name>` git remote on the host. Local
   * sandboxes only.
   *
   * @defaultValue `false`
   */
  clone?: boolean;
  /** More directories of this host, mounted read-only: documentation, a shared library… Local only. */
  readOnlyWorkspaces?: readonly string[];
  /**
   * Hosts the sandbox may never reach, on top of the network policy (`sbx create --deny-network`).
   * A deny can only narrow egress: it holds even if the policy allows the host.
   */
  denyNetwork?: readonly string[];
  /** Hosts a cloud sandbox may reach, on top of the account's policy. Cloud sandboxes only. */
  allowNetwork?: readonly string[];
  /**
   * CPUs given to the microVM. Default: decided by `sbx`. In the cloud, `cpus` and `memory` must
   * name a billable shape together: 1 / `2g`, 2 / `4g`, 4 / `8g`, 8 / `16g`…
   */
  cpus?: number;
  /** Memory limit of the microVM, in binary units (`4g`, `512m`). Default: decided by `sbx`. */
  memory?: string;
  /**
   * How long a cloud sandbox lives (`30m`, `2h`) before it times out; at most 24 hours. Default:
   * decided by the platform. Cloud sandboxes only.
   */
  ttl?: string;
  /**
   * What happens to a cloud sandbox when its `ttl` lapses: `stop` it in place, `restart` it, or
   * `delete` it. Default: decided by the platform. Cloud sandboxes only.
   */
  onTimeout?: 'delete' | 'restart' | 'stop';
  /** CPU architecture of a cloud sandbox. Default: the template's, or the platform's. Cloud only. */
  platform?: 'linux/amd64' | 'linux/arm64';
  /**
   * Commands run once, right after the sandbox is created, to install a tool the harness needs,
   * say. They run as the sandbox user, who has passwordless `sudo` in the Docker Sandboxes kits.
   * With a `template`, they run before it is prepared and are baked into it.
   */
  setup?: readonly string[];
}

/** Options of `createSbxNetworkSandboxSession()`. */
export type SbxNetworkSandboxSessionCreateOptions =
  HarnessV1SandboxSessionCreateOptions<SbxCreationSettings>;

/** Options of `resumeSbxNetworkSandboxSession()`. */
export type SbxNetworkSandboxSessionResumeOptions =
  HarnessV1SandboxSessionResumeOptions<SbxConnectionSettings>;
