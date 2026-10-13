import type { SrtRuntime } from '../transport/srt-runtime.js';

/**
 * The hosts one sandbox may reach: those its settings or its network policy list, and those its
 * views' credentials go to. Applied to srt under the commandId of the sandbox's supervisor of the
 * moment, the one srt tags its traffic with.
 */
export class SandboxNetwork {
  private commandId: string | undefined;
  private readonly credentialHosts = new Map<object, readonly string[]>();

  constructor(
    private readonly runtime: SrtRuntime,
    private allowed: readonly string[],
  ) {}

  /** Every host the sandbox may reach. */
  get domains(): string[] {
    return [...new Set([...this.allowed, ...[...this.credentialHosts.values()].flat()])];
  }

  /** A supervisor started under `commandId`: its traffic is the sandbox's. */
  attach(commandId: string): void {
    if (this.commandId !== undefined) this.runtime.forget(this.commandId);
    this.commandId = commandId;
    this.apply();
  }

  /** The supervisor started under `commandId` is gone. */
  detach(commandId: string): void {
    this.runtime.forget(commandId);
    if (this.commandId === commandId) this.commandId = undefined;
  }

  /** Replaces the hosts the sandbox's settings or policy allow. */
  setAllowed(domains: readonly string[]): void {
    this.allowed = [...domains];
    this.apply();
  }

  /** Replaces the hosts the credentials of the view `owner` go to. */
  setCredentialHosts(owner: object, hosts: readonly string[]): void {
    if (hosts.length === 0) this.credentialHosts.delete(owner);
    else this.credentialHosts.set(owner, hosts);
    this.apply();
  }

  private apply(): void {
    if (this.commandId !== undefined) this.runtime.allow(this.commandId, this.domains);
  }
}
