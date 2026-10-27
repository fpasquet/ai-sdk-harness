import type { HarnessV1RequestTransformation } from '@ai-sdk/harness';

import type { ProxyRegistration } from '../protocol/proxy.js';
import type { EgressPolicy } from './egress-policy.js';

import { HttpError } from '../common/http-error.js';
import { normalizeAddress, RegisteredSandbox } from './registered-sandbox.js';

/**
 * The sandboxes the proxy serves, by name and by the address of their machine. Kept in memory
 * alone: the credentials never touch a disk. A connection from an address no sandbox holds is
 * refused.
 */
export class SandboxRegistry {
  private readonly byName = new Map<string, RegisteredSandbox>();
  private readonly byAddress = new Map<string, string>();

  /**
   * @param allowPrivateNetwork Let the sandboxes reach private addresses and plain HTTP base URLs:
   *   tests and local runs only.
   */
  constructor(private readonly allowPrivateNetwork = false) {}

  /**
   * Registers the sandbox `name`, or registers it again after its machine started anew, perhaps
   * on another address: what it may reach is replaced, its credentials kept.
   */
  register(name: string, registration: ProxyRegistration): void {
    const next = new RegisteredSandbox(name, registration, this.allowPrivateNetwork);
    const previous = this.byName.get(name);
    if (previous !== undefined) {
      next.transformations = previous.transformations;
      this.forgetAddress(name, previous.address);
    }
    this.byName.set(name, next);
    this.byAddress.set(next.address, name);
  }

  /** Replaces the hosts the sandbox `name` may reach. */
  setAllowedHosts(name: string, allowedHosts: readonly string[]): void {
    this.get(name).allowedHosts = allowedHosts;
  }

  addTransformations(name: string, transformations: HarnessV1RequestTransformation[]): void {
    this.get(name).transformations.push(...transformations);
  }

  setTransformations(name: string, transformations: HarnessV1RequestTransformation[]): void {
    this.get(name).transformations = transformations;
  }

  /** Whether one of `texts` holds a credential the proxy keeps for the sandbox `name`. */
  holdsSecret(name: string, texts: readonly string[]): boolean {
    const secrets = this.byName.get(name)?.secrets ?? [];
    return secrets.some((secret) => texts.some((text) => text.includes(secret)));
  }

  /** Forgets the sandbox `name` and its credentials. Idempotent. */
  remove(name: string): void {
    const sandbox = this.byName.get(name);
    if (sandbox === undefined) return;
    this.byName.delete(name);
    this.forgetAddress(name, sandbox.address);
  }

  /** The policy of the sandbox whose machine has `address`, if one has. */
  policyFor(address: string | undefined): EgressPolicy | undefined {
    const name = this.byAddress.get(normalizeAddress(address ?? ''));
    return name === undefined ? undefined : this.byName.get(name);
  }

  private get(name: string): RegisteredSandbox {
    const sandbox = this.byName.get(name);
    if (sandbox === undefined) throw new HttpError(404, `The proxy knows no sandbox "${name}".`);
    return sandbox;
  }

  /** Drops the address of `name`, unless another sandbox's machine holds it now. */
  private forgetAddress(name: string, address: string): void {
    if (this.byAddress.get(address) === name) this.byAddress.delete(address);
  }
}
