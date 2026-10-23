import { InvalidHostError } from '../errors/invalid-host-error.js';

/** A label of a host name: letters, digits and inner `-`. */
const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';

/**
 * A host name, or `*.<domain>` for its subdomains, the domain of two labels at least: `*` alone
 * or `*.com` would open the whole network.
 */
const HOST = new RegExp(`^(?:${LABEL}(?:\\.${LABEL})*|\\*\\.${LABEL}(?:\\.${LABEL})+)$`, 'i');

/**
 * A network policy that lets the sandbox reach `hosts` and nothing else, as `@ai-sdk/harness`
 * writes it (`HarnessV1NetworkPolicy`): the `networkPolicy` of a sandbox, or of
 * `setNetworkPolicy()` on a running one.
 */
export interface AllowedHostsPolicy {
  mode: 'custom';
  allowedHosts: string[];
}

/**
 * Whether `host` is one a network policy takes: a host name (`api.github.com`), or `*.<domain>`
 * for the subdomains of a domain of two labels at least (`*.githubusercontent.com`). No scheme,
 * path nor port.
 */
export function isAllowedHost(host: string): boolean {
  return host.length <= 253 && HOST.test(host);
}

/**
 * The hosts of `lists`, in lower case, each once and sorted: what a network policy's
 * `allowedHosts` takes, from presets, the hosts of a workspace or of plugins, and your own.
 *
 * @throws {InvalidHostError} for a host {@link isAllowedHost} refuses.
 */
export function allowedHosts(...lists: readonly (readonly string[])[]): string[] {
  const hosts = lists.flat().map((host) => {
    if (!isAllowedHost(host)) throw new InvalidHostError(host);
    return host.toLowerCase();
  });
  return [...new Set(hosts)].sort();
}

/**
 * A network policy that lets the sandbox reach the hosts of `lists`, and nothing else: see
 * {@link allowedHosts}.
 *
 * @throws {InvalidHostError} for a host {@link isAllowedHost} refuses.
 */
export function networkPolicy(...lists: readonly (readonly string[])[]): AllowedHostsPolicy {
  return { mode: 'custom', allowedHosts: allowedHosts(...lists) };
}
