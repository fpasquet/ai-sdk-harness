import type { HarnessV1RequestTransformation } from '@ai-sdk/harness';
import type { IncomingHttpHeaders } from 'node:http';

type Matcher = { exact: string } | { regex: string } | { startsWith: string };
type KeyValueMatcher = { key?: Matcher; value?: Matcher };

/** What one sandbox may reach, and the credentials its requests leave with. */
export interface EgressPolicy {
  /** Hosts it may reach, `*.domain` for a domain's subdomains, `*` for any. */
  readonly allowedHosts: readonly string[];
  /** Hosts its base URLs point to: the model APIs, always reachable through their routes. */
  readonly upstreamHosts: readonly string[];
  /** Applied to its requests on their way out, outside the sandbox. */
  readonly transformations: readonly HarnessV1RequestTransformation[];
  /** Let it reach private addresses and plain HTTP base URLs: tests and local runs only. */
  readonly allowPrivateNetwork: boolean;
}

/** What the egress proxy knows of one request on its way out. */
export interface OutgoingRequest {
  host: string;
  method: string;
  /** Path and query string, as sent. */
  path: string;
  headers: IncomingHttpHeaders;
}

function matches(matcher: Matcher | undefined, value: string, caseInsensitive = false): boolean {
  if (matcher === undefined) return true;
  const normalize = (text: string): string => (caseInsensitive ? text.toLowerCase() : text);
  if ('exact' in matcher) return normalize(value) === normalize(matcher.exact);
  if ('startsWith' in matcher) return normalize(value).startsWith(normalize(matcher.startsWith));
  return new RegExp(matcher.regex, caseInsensitive ? 'i' : '').test(value);
}

function headerPairs(headers: IncomingHttpHeaders): [string, string][] {
  return Object.entries(headers).flatMap(([name, value]) =>
    value === undefined ? [] : (Array.isArray(value) ? value : [value]).map((v) => [name, v]),
  ) as [string, string][];
}

/** Whether every matcher finds a pair that satisfies it. */
const allMatch = (
  matchers: readonly KeyValueMatcher[] = [],
  pairs: [string, string][],
  caseInsensitiveKeys: boolean,
): boolean =>
  matchers.every(({ key, value }) =>
    pairs.some(([name, v]) => matches(key, name, caseInsensitiveKeys) && matches(value, v)),
  );

/** Whether `transformation` applies to `request`: every condition it sets must hold. */
export function appliesTo(
  transformation: HarnessV1RequestTransformation,
  request: OutgoingRequest,
): boolean {
  const { host, path, method, headers, queryString } = transformation.match;
  if (host.toLowerCase() !== request.host.toLowerCase()) return false;
  const url = new URL(request.path, 'http://request');
  if (!matches(path, url.pathname)) return false;
  if (method !== undefined && !method.some((m) => m.toUpperCase() === request.method)) {
    return false;
  }
  return (
    allMatch(headers, headerPairs(request.headers), true) &&
    allMatch(queryString, [...url.searchParams.entries()], false)
  );
}

/**
 * The headers `request` leaves with: those it came with, each transformation that applies to it
 * replacing the headers it names.
 */
export function transformHeaders(
  transformations: readonly HarnessV1RequestTransformation[],
  request: OutgoingRequest,
): IncomingHttpHeaders {
  const headers = { ...request.headers };
  for (const transformation of transformations) {
    if (!appliesTo(transformation, request)) continue;
    for (const [name, value] of Object.entries(transformation.transform.headers)) {
      headers[name.toLowerCase()] = value;
    }
  }
  return headers;
}

/**
 * Whether `host` is on the list `hosts`: listed as is, under a `*.domain` entry, or let through by
 * `*`. Names compare whatever their case; `*.domain` does not cover `domain` itself.
 */
export function isListedHost(hosts: readonly string[], host: string): boolean {
  const name = host.toLowerCase();
  return hosts.some((entry) => {
    const listed = entry.toLowerCase();
    if (listed === '*') return true;
    return listed.startsWith('*.') ? name.endsWith(listed.slice(1)) : name === listed;
  });
}

/**
 * Whether a request routed to `host` through a base URL may leave: the host is allowed, is one of
 * the base URLs' own, or is one a credential is brokered for.
 */
export function isRoutable(policy: EgressPolicy, host: string): boolean {
  return (
    isListedHost(policy.allowedHosts, host) ||
    isListedHost(policy.upstreamHosts, host) ||
    policy.transformations.some(({ match }) => match.host.toLowerCase() === host.toLowerCase())
  );
}
