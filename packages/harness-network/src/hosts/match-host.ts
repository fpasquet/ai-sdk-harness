/** How {@link matchesHost} reads a `*.<domain>` entry. */
export interface MatchesHostOptions {
  /**
   * Whether `*.example.com` covers `example.com` itself, beside its subdomains. Sandboxes differ:
   * microsandbox's covers it, srt's does not. `false`, the narrowest reading, never says a host is
   * allowed that a sandbox refuses. @defaultValue `false`
   */
  wildcardMatchesDomain?: boolean;
}

/** A host as it is compared: lower case, without the final dot of a fully qualified name. */
function normalized(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, '');
}

/**
 * Whether `host` matches an entry of `hosts`: a name listed as it is, or a subdomain of a
 * `*.<domain>` entry. `*.example.com` matches `api.example.com` and `*.api.example.com`, and
 * `example.com` itself only with `wildcardMatchesDomain`. Case and a final dot are ignored. What a
 * proxy checks a name against, what tells a settings page that a host is already allowed.
 */
export function matchesHost(
  hosts: readonly string[],
  host: string,
  { wildcardMatchesDomain = false }: MatchesHostOptions = {},
): boolean {
  const name = normalized(host);
  if (name === '' || name.startsWith('.')) return false;
  return hosts.some((entry) => {
    const rule = normalized(entry);
    if (!rule.startsWith('*.')) return name === rule;
    return name.endsWith(rule.slice(1)) || (wildcardMatchesDomain && name === rule.slice(2));
  });
}
