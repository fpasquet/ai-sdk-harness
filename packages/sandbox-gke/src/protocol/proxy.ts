/**
 * The administration API of the egress proxy (`ai-sdk-sandbox-gke proxy`), which only the sandbox
 * service calls, with the proxy's token as a bearer:
 *
 * - `GET /health`: `{ status, protocol, version }`, unauthenticated;
 * - `PUT /v1/sandboxes/:name`, a {@link ProxyRegistration}: the sandbox's pod is known by its
 *   address from then on; its credentials are kept when it was already registered;
 * - `PUT /v1/sandboxes/:name/network`: `{ allowedHosts }`, the hosts it may reach;
 * - `POST` and `PUT /v1/sandboxes/:name/transformations`: `{ transformations }`, added or replaced;
 * - `POST /v1/sandboxes/:name/screen`: `{ texts }`, answered `{ refused }`, whether one of them holds
 *   a credential the proxy keeps for the sandbox;
 * - `DELETE /v1/sandboxes/:name`: forgets the sandbox and its credentials.
 */

/** A sandbox, as the proxy knows it. */
export interface ProxyRegistration {
  /** The address of its pod: every connection from it is the sandbox's. */
  address: string;
  /** Hosts it may reach over HTTPS, `*.domain` for a domain's subdomains, `*` for any. */
  allowedHosts: readonly string[];
  /** Base URL variables and where they lead: their hosts are always reachable through a route. */
  baseUrls: Readonly<Record<string, string>>;
}

/** The port the proxy serves the sandboxes on. */
export const DEFAULT_PROXY_PORT = 3128;

/** The port of its administration API. */
export const DEFAULT_PROXY_ADMIN_PORT = 3129;
