import type { HarnessV1NetworkPolicy } from '@ai-sdk/harness';

import { HarnessCapabilityUnsupportedError } from '@ai-sdk/harness';
import { isIP } from 'node:net';

import { SRT_SANDBOX_PROVIDER_ID } from '../provider-id.js';

/** An address, or a range that holds a single one: what srt can allow. */
function addressOf(cidr: string): string | undefined {
  const [address = '', bits] = cidr.split('/');
  const version = isIP(address);
  if (version === 0) return undefined;
  if (bits === undefined || Number(bits) === (version === 4 ? 32 : 128)) {
    return version === 6 ? `[${address}]` : address;
  }
  return undefined;
}

function unsupported(message: string): HarnessCapabilityUnsupportedError {
  return new HarnessCapabilityUnsupportedError({ harnessId: SRT_SANDBOX_PROVIDER_ID, message });
}

/**
 * The hosts a sandbox may reach under `policy`, in srt's terms. srt filters by host name, allowing
 * only what it lists: it cannot allow everything, nor a range of addresses.
 */
export function domainsOf(policy: HarnessV1NetworkPolicy): string[] {
  if (policy.mode === 'deny-all') return [];
  if (policy.mode === 'allow-all') {
    throw unsupported(
      'srt allows the hosts it lists and nothing else: list them with { mode: "custom", allowedHosts }.',
    );
  }
  if ((policy.deniedCIDRs ?? []).length > 0) {
    throw unsupported('srt cannot deny ranges of addresses: list the hosts to allow instead.');
  }
  const addresses = (policy.allowedCIDRs ?? []).map((cidr) => {
    const address = addressOf(cidr);
    if (address === undefined) {
      throw unsupported(`srt allows single addresses, not the range ${cidr}.`);
    }
    return address;
  });
  return [...(policy.allowedHosts ?? []), ...addresses];
}
