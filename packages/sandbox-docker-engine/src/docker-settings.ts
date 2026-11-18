import type { HarnessV1NetworkPolicy } from '@ai-sdk/harness';

/** How this package reaches Docker Engine, and where it keeps what a sandbox needs on this host. */
export interface DockerConnectionSettings {
  /**
   * The `docker` CLI.
   *
   * @defaultValue `'docker'`, from the `PATH`
   */
  binary?: string;
  /**
   * The directory of this host where each sandbox keeps its state, in a directory of its own: the
   * network policy the egress proxy reads, the requests it refused, the sandbox's settings. A
   * resume needs the same one.
   *
   * @defaultValue `$XDG_STATE_HOME/ai-sdk-sandbox-docker-engine`, `~/.local/state/…` without it
   */
  stateDirectory?: string;
}

/** A directory of this host mounted in the sandbox. */
export interface DockerMount {
  /** The directory on this host: an absolute path. */
  from: string;
  /** Where the sandbox sees it: an absolute path. */
  to: string;
  /** The sandbox reads it, never writes it. @defaultValue `false` */
  readOnly?: boolean;
}

/** What the sandbox's container may use of this host. */
export interface DockerLimits {
  /**
   * Its memory, in bytes, or as Docker writes it (`'4g'`).
   *
   * @defaultValue 4 GiB
   */
  memory?: number | string;
  /** Its processors. @defaultValue `2` */
  cpus?: number;
  /** How many processes it may run at once. @defaultValue `512` */
  processes?: number;
}

/** How a sandbox on Docker Engine is created. */
export interface DockerNetworkSandboxSessionCreateOptions extends DockerConnectionSettings {
  /**
   * The image of the sandbox: what the agent runs in. It needs `sh` and `tail`, and Node.js for a
   * harness bridge; its egress proxy runs on its Node.js too, unless `proxyImage` says otherwise.
   */
  image: string;
  /**
   * The sandbox's name: its container's, its proxy's (`<name>-egress`) and its network's
   * (`<name>-net`). Keep it to resume the sandbox.
   *
   * @defaultValue `ai-sdk-docker-<random>`
   */
  sandboxId?: string;
  /** Directories of this host mounted in the sandbox: a repository, a cache. */
  mounts?: readonly DockerMount[];
  /** What the container may use: memory, processors, processes. */
  limits?: DockerLimits;
  /**
   * The hosts the sandbox may reach through its egress proxy; nothing else leaves its network.
   * `setNetworkPolicy()` changes it while the sandbox runs.
   *
   * @defaultValue `{ mode: 'deny-all' }`
   */
  networkPolicy?: HarnessV1NetworkPolicy;
  /** The ports of the sandbox a harness bridge listens on: published on this host's loopback. */
  ports?: readonly number[];
  /**
   * The sandbox's working directory, which Docker creates if the image lacks it.
   *
   * @defaultValue `'/workspace'`
   */
  workingDirectory?: string;
  /** The user the sandbox runs as, `uid[:gid]` or a name of the image. @defaultValue the image's */
  user?: string;
  /**
   * Variables of the sandbox's environment, every command's. Never a secret: the agent reads them.
   */
  env?: Record<string, string>;
  /**
   * The image the egress proxy runs in, with Node.js 22.7 or later.
   *
   * @defaultValue `image`
   */
  proxyImage?: string;
  abortSignal?: AbortSignal;
}

/** How a sandbox created earlier is found again. */
export interface DockerNetworkSandboxSessionResumeOptions extends DockerConnectionSettings {
  /** The name it was created with: `sandboxSession.id`. */
  sandboxId: string;
  abortSignal?: AbortSignal;
}
