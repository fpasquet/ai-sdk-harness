import type { HarnessV1NetworkPolicy } from '@ai-sdk/harness';

import type { SbxCli } from '../transport/sbx-cli.js';

/** A rule of the Docker Sandboxes policy, as `sbx policy ls --json` lists it. */
interface PolicyRule {
  id: string;
  scope?: string;
  decision?: string;
  resource_type?: string;
  resources?: string[];
  /** What the rule allows or denies of its resources: `net:connect:tcp`, `net:connect:udp`. */
  actions?: string[];
}

type Protocol = 'tcp' | 'udp';

const BOTH: readonly Protocol[] = ['tcp', 'udp'];

/** What `rule` allows or denies, one entry per resource and protocol. */
const entriesOf = ({ decision, resources = [], actions = [] }: PolicyRule): string[] =>
  resources.flatMap((resource) => actions.map((action) => `${decision} ${resource} ${action}`));

/** The rules of the machine's policy, every sandbox's scoped ones included. */
async function listRules(cli: SbxCli): Promise<PolicyRule[]> {
  const listed = await cli.check(['policy', 'ls', '--type', 'network', '--json'], { retry: true });
  return (JSON.parse(listed) as { rules?: PolicyRule[] }).rules ?? [];
}

/** A host or a pattern without its port, and what it stands for without its wildcard. */
function baseOf(resource: string): { wildcard: boolean; name: string } {
  const host = resource.startsWith('[') ? resource : resource.replace(/:\d+$/, '');
  const name = host.replace(/^\*\*?\./, '').toLowerCase();
  return { wildcard: name !== host.toLowerCase(), name };
}

/** Whether `a` and `b` reach a host in common: the same name, or one a wildcard covers. */
function overlap(a: string, b: string): boolean {
  const left = baseOf(a);
  const right = baseOf(b);
  return (
    left.name === right.name ||
    (left.wildcard && right.name.endsWith(`.${left.name}`)) ||
    (right.wildcard && left.name.endsWith(`.${right.name}`))
  );
}

/** The harness's `*.example.com` is the domain's subdomains, at any depth: `**.` for `sbx`. */
const sbxPattern = (host: string): string => (host.startsWith('*.') ? `*${host}` : host);

/**
 * Applies a harness network policy to one local sandbox, as rules of the Docker Sandboxes policy
 * scoped to it, on top of the machine's own policy, which the proxy applies to every sandbox and
 * which keeps private networks, this host and the metadata server out of reach.
 *
 * - `allow-all` (or a `custom` policy allowing `*`) is the machine's policy as it is.
 * - `deny-all` denies every host.
 * - `custom` allows the listed hosts and blocks, denies `deniedCIDRs`, and denies whatever else
 *   the machine's policy allows: the sandbox reaches the listed hosts only. A deny wins over an
 *   allow, even a narrower one, so what the machine allows under a listed host's domain is left
 *   allowed rather than denied.
 *
 * The rules a previous call scoped to the sandbox are removed once the new ones are in place, but
 * those the new policy holds too: `sbx` keeps one rule per host and protocol, and adds none for a
 * host and protocol it already has a rule for. `sbx` removes them with the sandbox.
 */
export async function applyNetworkPolicy(
  cli: SbxCli,
  sandbox: string,
  policy: HarnessV1NetworkPolicy,
): Promise<void> {
  const rules = await listRules(cli);
  const scope = `sandbox:${sandbox}`;
  const previous = rules.filter((rule) => rule.scope === scope);
  const wanted = new Set<string>();
  /** Adds the rules scoped to the sandbox for `resources`, over `protocols`. */
  const add = async (
    decision: 'allow' | 'deny',
    resources: readonly string[],
    protocols: readonly Protocol[] = BOTH,
  ) => {
    if (resources.length === 0) return;
    for (const resource of resources)
      for (const protocol of protocols)
        wanted.add(`${decision} ${resource} net:connect:${protocol}`);
    const sandboxScope = ['--sandbox', sandbox, '--protocol', protocols.join(',')];
    await cli.check(['policy', decision, 'network', ...sandboxScope, resources.join(',')]);
  };

  if (policy.mode === 'deny-all') {
    await add('deny', ['**']);
  } else if (policy.mode === 'custom' && !(policy.allowedHosts ?? []).includes('*')) {
    const hosts = (policy.allowedHosts ?? []).map(sbxPattern);
    const allowedElsewhere = rules
      .filter(
        ({ scope: ruleScope = 'global', decision }) =>
          decision === 'allow' && !ruleScope.startsWith('sandbox:'),
      )
      .flatMap(({ resources = [] }) => resources)
      .filter((resource) => !hosts.some((host) => overlap(host, resource)));
    // Hosts over TCP, as `sbx` allows them by default; blocks over UDP too.
    await add('allow', hosts, ['tcp']);
    await add('allow', policy.allowedCIDRs ?? []);
    await add('deny', [...(policy.deniedCIDRs ?? []), ...new Set(allowedElsewhere)]);
  }
  const replaced = previous.filter((rule) => !entriesOf(rule).every((entry) => wanted.has(entry)));
  for (const { id } of replaced) {
    await cli.check(['policy', 'rm', 'network', '--sandbox', sandbox, '--id', id, '--force']);
  }
}
