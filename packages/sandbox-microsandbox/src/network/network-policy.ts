import type { HarnessV1NetworkPolicy } from '@ai-sdk/harness';
import type { Destination, NetworkPolicy, Rule } from 'microsandbox';

const egress = (action: Rule['action'], destination: Destination): Rule => ({
  direction: 'egress',
  destination,
  protocols: [],
  ports: [],
  action,
});

/** `*.example.com` stands for the domain and its subdomains, any other entry for itself. */
const host = (name: string): Destination =>
  name.startsWith('*.')
    ? { kind: 'domainSuffix', suffix: name.slice(1) }
    : { kind: 'domain', domain: name };

const cidr = (block: string): Destination => ({ kind: 'cidr', cidr: block });

/**
 * The microsandbox policy of a harness network policy. Rules match first to last, so the denied
 * blocks come first. Ingress stays allowed: it is how the published ports are reached.
 *
 * `allow-all` opens the public internet, not every address: an allowed egress by default would let
 * the sandbox reach this host's services, its private networks and the cloud metadata server.
 * Private blocks are opened by naming them in `allowedCIDRs`. It also opens DNS on the gateway,
 * microsandbox's own resolver, which a `custom` policy gets for the names it lists.
 */
export function toNetworkPolicy(policy: HarnessV1NetworkPolicy): NetworkPolicy {
  switch (policy.mode) {
    case 'allow-all':
      return {
        defaultEgress: 'deny',
        defaultIngress: 'allow',
        rules: [
          egress('allow', { kind: 'group', group: 'public' }),
          {
            ...egress('allow', { kind: 'group', group: 'host' }),
            protocols: ['udp', 'tcp'],
            ports: [{ start: 53, end: 53 }],
          },
        ],
      };
    case 'deny-all':
      return { defaultEgress: 'deny', defaultIngress: 'allow', rules: [] };
    case 'custom': {
      const { allowedHosts = [], allowedCIDRs = [], deniedCIDRs = [] } = policy;
      return {
        defaultEgress: 'deny',
        defaultIngress: 'allow',
        rules: [
          ...deniedCIDRs.map((block) => egress('deny', cidr(block))),
          ...allowedHosts.map((name) => egress('allow', host(name))),
          ...allowedCIDRs.map((block) => egress('allow', cidr(block))),
        ],
      };
    }
  }
}
