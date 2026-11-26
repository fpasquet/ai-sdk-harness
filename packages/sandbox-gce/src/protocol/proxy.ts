/**
 * The administration API of the egress proxy (`ai-sdk-sandbox-gce proxy`), which only the sandbox
 * service calls, with the proxy's token as a bearer:
 *
 * - `GET /health`: `{ status, protocol, version }`, unauthenticated;
 * - `PUT /v1/sandboxes/:name`, a {@link ProxyRegistration}: the sandbox's machine is known by its
 *   address from then on; its credentials are kept when it was already registered;
 * - `PUT /v1/sandboxes/:name/network`: `{ allowedHosts }`, the hosts it may reach;
 * - `POST` and `PUT /v1/sandboxes/:name/transformations`: `{ transformations }`, added or replaced;
 * - `POST /v1/sandboxes/:name/screen`: `{ texts }`, answered `{ refused }`, whether one of them holds
 *   a credential the proxy keeps for the sandbox;
 * - `GET /v1/sandboxes/:name/usage`: the {@link ProxyUsage} of the sandbox;
 * - `DELETE /v1/sandboxes/:name`: forgets the sandbox and its credentials, answered `{ usage }`, its
 *   last {@link ProxyUsage}, unless it knew none (204).
 */

/** A sandbox, as the proxy knows it. */
export interface ProxyRegistration {
  /** The internal address of its machine: every connection from it is the sandbox's. */
  address: string;
  /** Hosts it may reach over HTTPS, `*.domain` for a domain's subdomains, `*` for any. */
  allowedHosts: readonly string[];
  /** Base URL variables and where they lead: their hosts are always reachable through a route. */
  baseUrls: Readonly<Record<string, string>>;
}

/**
 * The bytes a sandbox's connections carried through the egress proxy, since it registered the
 * sandbox: its creation, or its last resume from a stop. Counted outside the machine, where nothing
 * the sandbox runs changes them; in the proxy's memory alone, lost when it restarts.
 */
export interface ProxyUsage {
  /**
   * The bytes the proxy read from the sandbox: what it sent out, the requests and the TLS of its
   * tunnels, their headers included.
   */
  bytesRead: number;
  /** The bytes the proxy wrote to the sandbox: what it downloaded, answers and tunnels alike. */
  bytesWritten: number;
  /** The connections the sandbox opened to the proxy, those it refused included. */
  connections: number;
  /** Those still open, whose bytes so far are counted. */
  openConnections: number;
  /** Since when the proxy counts, an ISO 8601 timestamp: when it registered the sandbox. */
  since: string;
}

/** The port the proxy serves the sandboxes on. */
export const DEFAULT_PROXY_PORT = 3128;

/** The port of its administration API. */
export const DEFAULT_PROXY_ADMIN_PORT = 3129;
