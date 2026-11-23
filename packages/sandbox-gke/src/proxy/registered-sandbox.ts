import type { HarnessV1RequestTransformation } from '@ai-sdk/harness';

import type { ProxyRegistration } from '../protocol/proxy.js';
import type { EgressPolicy } from './egress-policy.js';

import { hostsOf } from '../protocol/proxy-routes.js';

/** The scheme a credential header value may start with, before the secret itself. */
const SCHEME = /^(Bearer|Basic|Token)\s+/i;

/** Shorter values are no secret worth guarding, and would match by chance. */
const MIN_SECRET_LENGTH = 12;

/** An IPv4 address as Node.js reports a connection's on a dual-stack socket: `::ffff:10.0.0.3`. */
export const normalizeAddress = (address: string): string =>
  address.replace(/^::ffff:(?=\d+\.)/i, '');

/** One sandbox, as the proxy knows it: its pod's address, what it may reach, its credentials. */
export class RegisteredSandbox implements EgressPolicy {
  address: string;
  allowedHosts: readonly string[];
  upstreamHosts: readonly string[];
  transformations: HarnessV1RequestTransformation[] = [];

  constructor(
    registration: ProxyRegistration,
    readonly allowPrivateNetwork: boolean,
  ) {
    this.address = normalizeAddress(registration.address);
    this.allowedHosts = registration.allowedHosts;
    this.upstreamHosts = hostsOf(registration.baseUrls);
  }

  /** The secrets the proxy holds for the sandbox: what its transformations put in requests. */
  get secrets(): string[] {
    return this.transformations
      .flatMap(({ transform }) => Object.values(transform.headers))
      .map((value) => value.replace(SCHEME, ''))
      .filter((secret) => secret.length >= MIN_SECRET_LENGTH);
  }
}
