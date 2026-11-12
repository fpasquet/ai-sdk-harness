import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/** How long the proxy's resolved address is kept: a Service's cluster IP does not move. */
const ADDRESS_KEPT_MS = 60_000;

/**
 * The egress proxy's URL as the pods reach it: by address, since they have no resolver. A host
 * name, the proxy's Service's say, is resolved by the service, and again once in a while.
 */
export function proxyAddress(url: string): () => Promise<string> {
  const parsed = new URL(url);
  if (isIP(parsed.hostname.replace(/^\[|\]$/g, '')) !== 0) return () => Promise.resolve(url);
  let cached: undefined | { url: string; until: number };
  return async () => {
    if (cached !== undefined && Date.now() < cached.until) return cached.url;
    const { address, family } = await lookup(parsed.hostname);
    const resolved = new URL(url);
    resolved.hostname = family === 6 ? `[${address}]` : address;
    cached = { url: resolved.href.replace(/\/$/, ''), until: Date.now() + ADDRESS_KEPT_MS };
    return cached.url;
  };
}
