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
 */
export function toNetworkPolicy(policy: HarnessV1NetworkPolicy): NetworkPolicy {
  switch (policy.mode) {
    case 'allow-all':
      return { defaultEgress: 'allow', defaultIngress: 'allow', rules: [] };
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
