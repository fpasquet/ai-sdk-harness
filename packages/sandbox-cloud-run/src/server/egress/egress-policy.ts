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

/**
 * Whether every matcher of the query string finds a parameter that satisfies it, and, when it
 * names its key, no parameter of that key that does not: `?service=git-upload-pack&service=
 * git-receive-pack` satisfies no rule for `service=git-upload-pack`, whichever of the two the
 * server reads.
 */
const queryMatches = (
  matchers: readonly KeyValueMatcher[] = [],
  pairs: [string, string][],
): boolean =>
  matchers.every(({ key, value }) => {
    if (key === undefined) return pairs.some(([, v]) => matches(value, v));
    const named = pairs.filter(([name]) => matches(key, name));
    return named.length > 0 && named.every(([, v]) => matches(value, v));
  });

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
    queryMatches(queryString, [...url.searchParams.entries()])
  );
}

/** Shorter than this, a header value a rule matches is no placeholder: it could be sent by chance. */
const MIN_PLACEHOLDER_LENGTH = 16;

/**
 * The placeholders a transformation swaps: the exact value it matches in a header it replaces,
 * long enough to have been made for it.
 */
function placeholdersOf({ match, transform }: HarnessV1RequestTransformation): string[] {
  const replaced = new Set(Object.keys(transform.headers).map((name) => name.toLowerCase()));
  return (match.headers ?? []).flatMap(({ key, value }) =>
    key !== undefined &&
    'exact' in key &&
    replaced.has(key.exact.toLowerCase()) &&
    value !== undefined &&
    'exact' in value &&
    value.exact.length >= MIN_PLACEHOLDER_LENGTH
      ? [value.exact]
      : [],
  );
}

/**
 * Whether `request` carries a placeholder of a transformation, in any header, where no
 * transformation for that placeholder applies: another path, method, query or host than its rules
 * name, such as a push with the placeholder of a credential brokered for reading a repository.
 * The proxy refuses it rather than send it on: no rule covers it, and none must ever be widened
 * by what the sandbox sends.
 */
export function carriesStrayPlaceholder(
  transformations: readonly HarnessV1RequestTransformation[],
  request: OutgoingRequest,
): boolean {
  const sent = new Set(headerPairs(request.headers).map(([, value]) => value));
  const stray = new Set<string>();
  const covered = new Set<string>();
  for (const transformation of transformations) {
    const carried = placeholdersOf(transformation).filter((placeholder) => sent.has(placeholder));
    if (carried.length === 0) continue;
    const into = appliesTo(transformation, request) ? covered : stray;
    for (const placeholder of carried) into.add(placeholder);
  }
  return [...stray].some((placeholder) => !covered.has(placeholder));
}

/** What a rule matches, comparable: its matchers, whatever the order of their keys. */
function matchKey({ match }: HarnessV1RequestTransformation): string {
  const sorted = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sorted);
    if (value === null || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, item]) => [name, sorted(item)]),
    );
  };
  return JSON.stringify(sorted(match));
}

/**
 * `existing`, then `added`, each added rule replacing one that matches exactly the same requests:
 * a credential renewed for the same placeholder takes the place of the one before, rather than
 * piling up beside it.
 */
export function withTransformations(
  existing: readonly HarnessV1RequestTransformation[],
  added: readonly HarnessV1RequestTransformation[],
): HarnessV1RequestTransformation[] {
  const replaced = new Set(added.map(matchKey));
  const kept = existing.filter((transformation) => !replaced.has(matchKey(transformation)));
  // The last of several added rules for one match wins, as it would added one after the other.
  const last = new Map(added.map((transformation) => [matchKey(transformation), transformation]));
  return [...kept, ...last.values()];
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

/** The scheme a credential header carries before the credential itself. */
const SCHEME = /^(Bearer|Basic|Token)\s+/i;

/** Shorter than this, a value could turn up in a response by chance: not worth withholding. */
const MIN_CREDENTIAL_LENGTH = 8;

/**
 * The credentials the transformations that apply to `request` put in it: each header value, and
 * the credential it carries after its scheme.
 */
export function injectedCredentials(
  transformations: readonly HarnessV1RequestTransformation[],
  request: OutgoingRequest,
): string[] {
  const values = transformations
    .filter((transformation) => appliesTo(transformation, request))
    .flatMap(({ transform }) => Object.values(transform.headers))
    .flatMap((value) => [value, value.replace(SCHEME, '')]);
  return [...new Set(values)].filter((value) => value.length >= MIN_CREDENTIAL_LENGTH);
}

/**
 * The headers of a response, without those holding one of `credentials`: an API that echoes the
 * request's headers back must not hand the sandbox the credential it never saw.
 */
export function withoutCredentials(
  headers: IncomingHttpHeaders,
  credentials: readonly string[],
): IncomingHttpHeaders {
  if (credentials.length === 0) return headers;
  const holds = (value: string | string[] | undefined): boolean =>
    (Array.isArray(value) ? value : [value ?? '']).some((item) =>
      credentials.some((credential) => item.includes(credential)),
    );
  return Object.fromEntries(Object.entries(headers).filter(([, value]) => !holds(value)));
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
