import { allowedHosts } from './allowed-hosts.js';
import { matchesHost, type MatchesHostOptions } from './match-host.js';

/** The lists of hosts {@link networkLayers} merges, each one a layer of the network policy. */
export interface NetworkLayersOptions extends MatchesHostOptions {
  /**
   * The hosts the harness cannot run without — `harnessHosts(harness.harnessId)` — which a
   * settings form shows but does not let one take out.
   */
  locked?: readonly string[];
  /** The hosts every sandbox may reach: the lists of an application's settings, the presets. */
  general?: readonly string[];
  /**
   * The hosts of named sources, each one's own: a repository, a project, a plugin. Only the
   * sandboxes that hold the source need them.
   */
  sources?: Readonly<Record<string, readonly string[]>>;
}

/** The layer an allowed host comes from. */
export type HostOrigin =
  | { layer: 'general' }
  | { layer: 'locked' }
  | {
      layer: 'source';
      /** The name of the source, a key of `sources`. */
      source: string;
    };

/** The hosts of every layer merged, and the way back from a host to the layers that allow it. */
export interface NetworkLayers {
  /** The hosts of every layer, checked, in lower case, each once and sorted: see `allowedHosts`. */
  allowedHosts: string[];
  /**
   * The layers that allow `host`, the locked hosts first, then the general list, then the sources
   * in the order they were given; empty for a host none allows. `host` is a name the sandbox
   * reached (`api.github.com`) or an entry of a list (`*.githubusercontent.com`), matched as
   * `matchesHost()` does, with the `wildcardMatchesDomain` of the layers.
   */
  originOf(host: string): HostOrigin[];
}

/**
 * The hosts a sandbox may reach, in layers that remember where each host comes from: the hosts
 * the harness cannot run without (`locked`), the general list (`general`) and those of each named
 * source (`sources`), a repository's or a project's. `allowedHosts` is what the network policy
 * takes; `originOf()` tells a settings page why a host is allowed, or a log of refused requests
 * which list to add a host to.
 *
 * @throws {InvalidHostError} for a host `isAllowedHost` refuses, in any layer.
 */
export function networkLayers({
  locked = [],
  general = [],
  sources = {},
  wildcardMatchesDomain = false,
}: NetworkLayersOptions): NetworkLayers {
  const layers: { origin: HostOrigin; hosts: string[] }[] = [
    { origin: { layer: 'locked' }, hosts: allowedHosts(locked) },
    { origin: { layer: 'general' }, hosts: allowedHosts(general) },
    ...Object.entries(sources).map(([source, hosts]) => ({
      origin: { layer: 'source', source } as const,
      hosts: allowedHosts(hosts),
    })),
  ];
  return {
    allowedHosts: allowedHosts(...layers.map(({ hosts }) => hosts)),
    originOf: (host) =>
      layers
        .filter(({ hosts }) => matchesHost(hosts, host, { wildcardMatchesDomain }))
        .map(({ origin }) => ({ ...origin })),
  };
}
