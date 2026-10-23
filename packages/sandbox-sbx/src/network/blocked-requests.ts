import type { SbxCli } from '../transport/sbx-cli.js';

/**
 * Requests to one host that the Docker Sandboxes proxy refused to a sandbox. The proxy keeps one
 * entry per host and port: its count and its first and last time add up every refusal.
 */
export interface SbxBlockedRequest {
  /** The host the sandbox tried to reach: a name, or an IP address. */
  host: string;
  /** The port it tried to reach. Absent for a name lookup the proxy's DNS refused. */
  port?: number;
  /** Why the proxy refused it, in its own words (`Denied by local rule`…). */
  reason: string;
  /** How many requests the proxy refused, since the first. */
  count: number;
  /** When the proxy first refused one. */
  firstSeen: Date;
  /** When the proxy last refused one. */
  lastSeen: Date;
}

/** Which of the refused requests to list. */
export interface SbxBlockedRequestsOptions {
  /** Only the hosts refused since then: the time of the last change of policy, for instance. */
  since?: Date;
  abortSignal?: AbortSignal;
}

/** An entry of `sbx policy log --json`. */
interface PolicyLogEntry {
  sandbox_id?: string;
  host?: string;
  reason?: string;
  count?: number;
  first_seen?: string;
  last_seen?: string;
}

/** `host:port`, `[v6 address]:port`, or a bare name from the proxy's DNS. */
const HOST_PORT = /^(?:\[(?<v6>[^\]]+)\]|(?<name>[^:[\]]+)):(?<port>\d+)$/;
/** Reverse lookups, which no network policy can allow. */
const REVERSE_LOOKUP = /\.(?:in-addr|ip6)\.arpa$/i;

/**
 * The requests the Docker Sandboxes proxy refused to one local sandbox, the last refused first, as
 * `sbx policy log` keeps them. The log is kept by sandbox name and outlives the sandbox: a new
 * sandbox of the same name inherits it, and a host stays listed once allowed. `since` leaves the
 * older refusals out.
 */
export async function blockedRequests(
  cli: SbxCli,
  sandbox: string,
  { since, abortSignal }: SbxBlockedRequestsOptions = {},
): Promise<SbxBlockedRequest[]> {
  const listed = await cli.check(['policy', 'log', sandbox, '--type', 'network', '--json'], {
    abortSignal,
    retry: true,
  });
  const { blocked = [] } = JSON.parse(listed) as { blocked?: PolicyLogEntry[] };
  // The sandbox's resolver tries a name under its search domain first: the same lookup again.
  const searchDomain = `.${sandbox}.docker.internal`.toLowerCase();
  return blocked
    .filter((entry) => entry.sandbox_id === sandbox && entry.host !== undefined)
    .map((entry) => toBlockedRequest(entry as PolicyLogEntry & { host: string }))
    .filter(
      ({ host, lastSeen }) =>
        !REVERSE_LOOKUP.test(host) &&
        !host.toLowerCase().endsWith(searchDomain) &&
        (since === undefined || lastSeen >= since),
    )
    .sort((a, b) => b.lastSeen.getTime() - a.lastSeen.getTime());
}

/** The host and port of a log entry: `[2001:db8::1]:443` is `2001:db8::1` and 443. */
function splitHost(logged: string): { host: string; port?: number } {
  const { v6, name, port } = HOST_PORT.exec(logged)?.groups ?? {};
  if (port === undefined) return { host: logged };
  return { host: v6 ?? name ?? logged, port: Number(port) };
}

function toBlockedRequest(entry: PolicyLogEntry & { host: string }): SbxBlockedRequest {
  const { first_seen: first = entry.last_seen, last_seen: last = entry.first_seen } = entry;
  return {
    ...splitHost(entry.host),
    reason: entry.reason ?? '',
    count: entry.count ?? 1,
    firstSeen: new Date(first ?? 0),
    lastSeen: new Date(last ?? 0),
  };
}
