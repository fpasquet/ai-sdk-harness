import type { HarnessV1NetworkPolicy } from '@ai-sdk/harness';

import { HarnessCapabilityUnsupportedError } from '@ai-sdk/harness';
import { rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { DOCKER_ENGINE_SANDBOX_PROVIDER_ID } from '../provider-id.js';

/** The file of the policy in the sandbox's state directory, which the proxy reads. */
export const POLICY_FILE = 'policy.json';

/** What the egress proxy reads of a network policy. */
export interface EgressPolicyFile {
  mode: 'allow-all' | 'custom' | 'deny-all';
  allowedHosts?: string[];
}

/**
 * The policy the proxy enforces for `policy`: every host, none, or the hosts it lists. CIDRs are
 * refused: the proxy sees host names, and connects to no private address whatever the policy.
 */
export function egressPolicyOf(policy: HarnessV1NetworkPolicy): EgressPolicyFile {
  if (policy.mode !== 'custom') return { mode: policy.mode };
  if ((policy.allowedCIDRs?.length ?? 0) > 0 || (policy.deniedCIDRs?.length ?? 0) > 0) {
    throw new HarnessCapabilityUnsupportedError({
      harnessId: DOCKER_ENGINE_SANDBOX_PROVIDER_ID,
      message:
        'The egress proxy of a Docker Engine sandbox allows hosts, not CIDRs: list the hosts in `allowedHosts`.',
    });
  }
  return { mode: 'custom', allowedHosts: [...(policy.allowedHosts ?? [])] };
}

/**
 * Writes the policy the proxy enforces into the state directory, replacing the file at once: the
 * proxy reads it at each connection, so that it applies to the next one.
 */
export async function writeNetworkPolicy(
  directory: string,
  policy: HarnessV1NetworkPolicy,
): Promise<void> {
  const file = join(directory, POLICY_FILE);
  const written = `${file}.${process.pid}.tmp`;
  await writeFile(written, `${JSON.stringify(egressPolicyOf(policy))}\n`);
  await rename(written, file);
}
