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
 * - `GET /v1/sandboxes`: `{ sandboxes }`, a {@link ProxySandbox} each, what the proxy holds and
 *   the bytes each moved;
 * - `DELETE /v1/sandboxes/:name`: forgets the sandbox and its credentials; with `?serial=`, only
 *   when that registration is still the sandbox's, not one made since.
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

/** A sandbox the proxy holds, as it lists them. */
export interface ProxySandbox {
  name: string;
  /** The address of its machine, normalized. */
  address: string;
  /** What tells its registration from the next one: another at each registration. */
  serial: number;
  /** The bytes it sent out through the proxy, and received back, since it was first registered. */
  sent: number;
  received: number;
}

/** The port the proxy serves the sandboxes on. */
export const DEFAULT_PROXY_PORT = 3128;

/** The port of its administration API. */
export const DEFAULT_PROXY_ADMIN_PORT = 3129;
