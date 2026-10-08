import type { LookupAddress, LookupOptions } from 'node:dns';

import { lookup } from 'node:dns';
import { BlockList, isIP } from 'node:net';

/**
 * Addresses a sandbox must never reach through the service: the service's own loopback, the
 * metadata server (169.254.169.254, the service account's token), the VPC and every other range
 * that is not the public internet.
 */
const PRIVATE = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 3],
] as const) {
  PRIVATE.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  PRIVATE.addSubnet(network, prefix, 'ipv6');
}

/** Whether `address`, an IP address, is outside the public internet. */
export function isPrivateAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (mapped !== undefined) return PRIVATE.check(mapped, 'ipv4');
  const family = isIP(address);
  if (family === 0) return false;
  return PRIVATE.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: LookupAddress[] | string,
  family?: number,
) => void;

/**
 * A DNS lookup for `net.connect` and `https.request` that refuses names resolving to a private
 * address: checked once resolved, on the address actually connected to, so that no name, however
 * it resolves, leads a sandbox to the metadata server.
 */
export function publicOnlyLookup(
  hostname: string,
  options: LookupOptions,
  callback: LookupCallback,
): void {
  lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) {
      callback(error, []);
      return;
    }
    const blocked = addresses.find(({ address }) => isPrivateAddress(address));
    if (blocked !== undefined) {
      callback(
        Object.assign(new Error(`${hostname} resolves to a private address`), { code: 'EPRIVATE' }),
        [],
      );
      return;
    }
    if (options.all === true) callback(null, addresses);
    else callback(null, addresses[0]?.address ?? '', addresses[0]?.family);
  });
}
