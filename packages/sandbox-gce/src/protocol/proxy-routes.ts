/**
 * Base URLs, routed through the egress proxy. A client that talks to a model API is pointed at the
 * proxy instead, in plain HTTP inside the VPC, under a path that names where the request really goes:
 *
 * `https://api.anthropic.com` becomes `http://10.0.0.2:3128/https/api.anthropic.com`, and a request
 * to `…/https/api.anthropic.com/v1/messages` leaves for `https://api.anthropic.com/v1/messages`.
 *
 * The proxy reads the request on its way out, which a TLS tunnel would hide: that is where the
 * placeholder credential the harness gave the sandbox is swapped for the real one.
 */

const ROUTE = /^\/(https?)\/([^/?#]+)([^?#]*)(\?[^#]*)?$/;

/** The variables pointed at the proxy by default, and where they lead. */
export const DEFAULT_BASE_URLS: Readonly<Record<string, string>> = {
  ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
  OPENAI_BASE_URL: 'https://api.openai.com/v1',
};

/** The proxy's route to `url`, or `undefined` when it is not an HTTP(S) URL or already a route. */
export function proxyRoute(url: string, proxyOrigin: string): string | undefined {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return undefined;
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') return undefined;
  if (target.origin === proxyOrigin) return undefined;
  const scheme = target.protocol.slice(0, -1);
  return `${proxyOrigin}/${scheme}/${target.host}${target.pathname.replace(/\/$/, '')}`;
}

/** Where a request the proxy received under `path` really goes, if `path` is a route. */
export function routeTarget(path: string): undefined | URL {
  const [, scheme, host, pathname, query = ''] = ROUTE.exec(path) ?? [];
  if (scheme === undefined || host === undefined) return undefined;
  return new URL(`${scheme}://${host}${pathname ?? ''}${query}`);
}

/** The hosts a set of base URLs points to. */
export function hostsOf(baseUrls: Readonly<Record<string, string>>): string[] {
  return Object.values(baseUrls).flatMap((url) => {
    try {
      return [new URL(url).hostname];
    } catch {
      return [];
    }
  });
}
