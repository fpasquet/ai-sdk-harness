import type { LookupAddress, LookupOptions } from 'node:dns';

import { lookup } from 'node:dns';
import { BlockList, isIP } from 'node:net';

/**
 * Addresses a sandbox must never reach through the proxy: the proxy's own loopback, the metadata
 * server (169.254.169.254, the proxy's service account token), the VPC and every other range
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

/** The two 16-bit groups of the IPv4 address of `bytes`. */
const ipv4Groups = ([a = 0, b = 0, c = 0, d = 0]: number[]): number[] => [
  (a << 8) | b,
  (c << 8) | d,
];

/** The eight 16-bit groups of the IPv6 address `address`, a trailing dotted IPv4 included. */
function groupsOf(address: string): number[] {
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(address);
  const hex =
    dotted === null
      ? address
      : address.slice(0, dotted.index) +
        ipv4Groups(dotted.slice(1).map(Number))
          .map((group) => group.toString(16))
          .join(':');
  const [head = '', tail] = hex.split('::');
  const parse = (part: string): number[] =>
    part === '' ? [] : part.split(':').map((group) => Number.parseInt(group, 16));
  const left = parse(head);
  const right = tail === undefined ? [] : parse(tail);
  return [...left, ...Array<number>(8 - left.length - right.length).fill(0), ...right];
}

/** The IPv4 address made of two 16-bit groups. */
const ipv4Of = (high = 0, low = 0): string =>
  [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');

/**
 * The IPv4 address an IPv6 one carries, which the network may route it to: NAT64
 * (`64:ff9b::/96`) and 6to4 (`2002::/16`).
 */
function embeddedIpv4(address: string): string | undefined {
  const groups = groupsOf(address);
  if (groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((g) => g === 0)) {
    return ipv4Of(groups[6], groups[7]);
  }
  if (groups[0] === 0x2002) return ipv4Of(groups[1], groups[2]);
  return undefined;
}

/** Whether `address`, an IP address, is outside the public internet. */
export function isPrivateAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (mapped !== undefined) return PRIVATE.check(mapped, 'ipv4');
  const family = isIP(address);
  if (family === 0) return false;
  if (family === 4) return PRIVATE.check(address, 'ipv4');
  const embedded = embeddedIpv4(address);
  if (embedded !== undefined && PRIVATE.check(embedded, 'ipv4')) return true;
  return PRIVATE.check(address, 'ipv6');
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
