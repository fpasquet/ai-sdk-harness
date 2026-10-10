import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';

import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import { isDeepStrictEqual } from 'node:util';

import { SrtError } from '../errors/srt-error.js';

/**
 * Settings of srt itself, for the whole process: srt keeps one proxy and one configuration per
 * process, shared by every sandbox. The first sandbox created or resumed applies them; another one
 * asking for different settings is refused.
 */
export interface SrtRuntimeSettings {
  /**
   * Run without srt's seccomp filter, which blocks Unix sockets on Linux. Needed where user
   * namespaces are restricted, such as Ubuntu 24.04 and later with
   * `kernel.apparmor_restrict_unprivileged_userns=1`: the filter's nested namespace fails there.
   * A process in the sandbox can then reach the Unix sockets it can see, such as the Docker
   * daemon's: hide them with `denyRead`.
   *
   * @defaultValue `false`
   */
  allowAllUnixSockets?: boolean;
  /** The `bwrap` binary (Linux). Default: looked up on the `PATH`. */
  bwrapPath?: string;
  /** The `socat` binary (Linux), which relays the proxy into the sandbox. Default: on the `PATH`. */
  socatPath?: string;
  /** The `rg` binary, which srt uses to find the files it must protect. Default: on the `PATH`. */
  ripgrepPath?: string;
  /**
   * srt's weaker mode for running inside a container that already isolates it, such as a Docker
   * container without privileges (Linux).
   *
   * @defaultValue `false`
   */
  enableWeakerNestedSandbox?: boolean;
}

/** What a sandbox may read and write, in srt's terms. */
export interface SrtFilesystem {
  denyRead: string[];
  allowRead: string[];
  allowWrite: string[];
  denyWrite: string[];
}

/** The part of srt's `SandboxManager` this package uses, as an interface its tests can fake. */
export interface SrtManager {
  checkDependencies(): { errors: string[]; warnings: string[] };
  getConfig(): SandboxRuntimeConfig | undefined;
  getSentinelRegistry(): {
    registerWithSentinel(
      name: string,
      sentinel: string,
      realValue: string,
      injectHosts: readonly string[],
    ): string;
  };
  initialize(config: SandboxRuntimeConfig): Promise<void>;
  isSupportedPlatform(): boolean;
  reset(): Promise<void>;
  /** From the srt release after 0.0.79: an allow list per wrapped command. */
  registerCommandNetworkLists?(commandId: string, lists: { allowedDomains?: string[] }): void;
  unregisterCommandNetworkLists?(commandId: string): void;
  updateConfig(config: SandboxRuntimeConfig): void;
  wrapWithSandbox(
    command: string,
    binShell?: string,
    customConfig?: Partial<SandboxRuntimeConfig>,
    abortSignal?: AbortSignal,
    options?: { commandId?: string },
  ): Promise<string>;
}

/** A credential srt puts in the requests leaving a sandbox, in place of its placeholder. */
export interface InjectedCredential {
  /** The value the sandbox holds, a whole header value. */
  placeholder: string;
  /** The value the request leaves with. */
  value: string;
  /** The hosts it is put in for; elsewhere the placeholder goes out as it is. */
  hosts: readonly string[];
}

/**
 * srt for this process: initialized once, then shared by every sandbox. Each sandbox is the one
 * command srt wraps — its supervisor — under its own filesystem rules and commandId.
 *
 * - **Network**: srt's proxy reads its allow list per connection. With the srt release after
 *   0.0.79, each sandbox has a list of its own, keyed by its commandId; before it, the proxy has a
 *   single list, the union of every sandbox's.
 * - **Credentials** go through srt's sentinel registry: srt swaps the placeholder the sandbox holds
 *   for the real value in the requests to the credential's hosts, past TLS termination.
 */
export class SrtRuntime {
  private readonly lists = new Map<string, readonly string[]>();
  private readonly credentialNames = new Map<string, string>();

  constructor(private readonly manager: SrtManager) {}

  /** Whether each sandbox has a network allow list of its own, or all share a union. */
  get isolatesNetworks(): boolean {
    return typeof this.manager.registerCommandNetworkLists === 'function';
  }

  /** The shell command that runs `command` under `filesystem`, its traffic tagged `commandId`. */
  wrap(
    command: string,
    { filesystem, commandId }: { commandId: string; filesystem: SrtFilesystem },
  ): Promise<string> {
    return this.manager.wrapWithSandbox(
      command,
      undefined,
      { filesystem, network: { allowedDomains: [], deniedDomains: [] } },
      undefined,
      { commandId },
    );
  }

  /** The hosts the command tagged `commandId` may reach, replacing what it could before. */
  allow(commandId: string, domains: readonly string[]): void {
    this.lists.set(commandId, [...new Set(domains)]);
    if (this.isolatesNetworks) {
      this.manager.registerCommandNetworkLists?.(commandId, { allowedDomains: [...domains] });
    } else {
      this.applyUnion();
    }
  }

  /** Withdraws the allow list of a command that is gone. */
  forget(commandId: string): void {
    if (!this.lists.delete(commandId)) return;
    if (this.isolatesNetworks) this.manager.unregisterCommandNetworkLists?.(commandId);
    else this.applyUnion();
  }

  /** Puts `credential` in the requests to its hosts, or updates it. */
  inject({ placeholder, value, hosts }: InjectedCredential): void {
    let name = this.credentialNames.get(placeholder);
    if (name === undefined) {
      name = `ai-sdk-sandbox-runtime-${this.credentialNames.size + 1}`;
      this.credentialNames.set(placeholder, name);
    }
    this.manager.getSentinelRegistry().registerWithSentinel(name, placeholder, value, hosts);
  }

  /**
   * Stops putting the credential of `placeholder` in requests. srt cannot drop a sentinel: it is
   * emptied and bound to no host, which leaves it inert.
   */
  withdraw(placeholder: string): void {
    const name = this.credentialNames.get(placeholder);
    if (name === undefined) return;
    this.manager.getSentinelRegistry().registerWithSentinel(name, placeholder, '', []);
  }

  private applyUnion(): void {
    const config = this.manager.getConfig();
    if (config === undefined) return;
    const allowedDomains = [...new Set([...this.lists.values()].flat())];
    this.manager.updateConfig({ ...config, network: { ...config.network, allowedDomains } });
  }
}

/** srt's configuration for this process: nothing allowed until a sandbox says what it may do. */
function runtimeConfig(
  settings: SrtRuntimeSettings,
  platform: NodeJS.Platform,
): SandboxRuntimeConfig {
  return {
    network: {
      allowedDomains: [],
      deniedDomains: [],
      // Credentials are put in HTTPS requests past TLS termination: srt's own CA, trusted in the
      // sandbox through the variables srt sets (NODE_EXTRA_CA_CERTS, SSL_CERT_FILE…).
      tlsTerminate: {},
      ...(settings.allowAllUnixSockets === true && { allowAllUnixSockets: true }),
      // macOS has no network namespace: a bridge listens on the host's own loopback, which the
      // sandbox may then reach. Linux gives each sandbox a loopback of its own.
      ...(platform === 'darwin' && { allowLocalBinding: true }),
    },
    filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
    // Turns srt's credential injector on; the credentials themselves come with the sandboxes.
    credentials: { envVars: [] },
    ...(settings.ripgrepPath !== undefined && { ripgrep: { command: settings.ripgrepPath } }),
    ...(settings.bwrapPath !== undefined && { bwrapPath: settings.bwrapPath }),
    ...(settings.socatPath !== undefined && { socatPath: settings.socatPath }),
    ...(settings.enableWeakerNestedSandbox === true && { enableWeakerNestedSandbox: true }),
  };
}

/** Starts srt, then checks it can run here: srt checks the binaries its configuration names. */
async function initialize(
  manager: SrtManager,
  settings: SrtRuntimeSettings,
  platform: NodeJS.Platform,
): Promise<SrtRuntime> {
  // The supervisor is a POSIX program: srt's Windows mode runs nothing it could start.
  if (platform === 'win32' || !manager.isSupportedPlatform()) {
    throw new SrtError(`This package runs srt on Linux and macOS, not on ${platform}.`);
  }
  try {
    await manager.initialize(runtimeConfig(settings, platform));
  } catch (error) {
    throw new SrtError(
      `srt did not start: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const { errors } = manager.checkDependencies();
  if (errors.length > 0) {
    await manager.reset();
    throw new SrtError(`srt cannot run on this host:\n- ${errors.join('\n- ')}`);
  }
  return new SrtRuntime(manager);
}

let current: undefined | { runtime: Promise<SrtRuntime>; settings: SrtRuntimeSettings };

/** `settings` without the keys left undefined, so that two spellings of the same settings match. */
function normalized(settings: SrtRuntimeSettings): SrtRuntimeSettings {
  return Object.fromEntries(Object.entries(settings).filter(([, value]) => value !== undefined));
}

/**
 * srt for this process, started on first use with `settings`. A later call with other settings is
 * refused: srt has one configuration per process.
 */
export function srtRuntime(
  settings: SrtRuntimeSettings = {},
  manager: SrtManager = SandboxManager,
  platform: NodeJS.Platform = process.platform,
): Promise<SrtRuntime> {
  if (current !== undefined) {
    if (!isDeepStrictEqual(current.settings, normalized(settings))) {
      return Promise.reject(
        new SrtError(
          'srt is already running in this process with other runtime settings: every sandbox of a process shares them.',
        ),
      );
    }
    return current.runtime;
  }
  const runtime = initialize(manager, settings, platform);
  current = { runtime, settings: normalized(settings) };
  runtime.catch(() => (current = undefined));
  return runtime;
}

/** @internal Forgets the runtime of this process, for the tests. */
export function resetSrtRuntime(): void {
  current = undefined;
}
