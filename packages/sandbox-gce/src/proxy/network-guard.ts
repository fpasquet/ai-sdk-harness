import type { LookupAddress, LookupOptions } from 'node:dns';

import { lookup } from 'node:dns';
import { BlockList, isIP } from 'node:net';

/**
 * IPv4 addresses a sandbox must never reach through the proxy: the proxy's own loopback, the
 * metadata server (169.254.169.254, the proxy's service account token), the VPC and every other
 * range that is not the public internet.
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
/**
 * The IPv6 addresses of the public internet: global unicast (`2000::/3`), and nothing else, so
 * that no range left out of a list of private ones (site-local, IPv4-compatible `::a.b.c.d`,
 * local-use NAT64) slips through.
 */
const GLOBAL_IPV6 = new BlockList();
GLOBAL_IPV6.addSubnet('2000::', 3, 'ipv6');

/**
 * The ranges of `2000::/3` that are no public host all the same: Teredo (`2001::/32`), whose
 * addresses carry an IPv4 one the network may route them to, benchmarking and documentation.
 */
const NOT_GLOBAL_IPV6 = new BlockList();
for (const [network, prefix] of [
  ['2001::', 32],
  ['2001:2::', 48],
  ['2001:db8::', 32],
  ['3fff::', 20],
] as const) {
  NOT_GLOBAL_IPV6.addSubnet(network, prefix, 'ipv6');
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
 * The IPv4 address an IPv6 one carries, which the network may route it to: IPv4-mapped
 * (`::ffff:0:0/96`), NAT64 (`64:ff9b::/96`) and 6to4 (`2002::/16`).
 */
function embeddedIpv4(address: string): string | undefined {
  const groups = groupsOf(address);
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return ipv4Of(groups[6], groups[7]);
  }
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
  if (embedded !== undefined) return PRIVATE.check(embedded, 'ipv4');
  return !GLOBAL_IPV6.check(address, 'ipv6') || NOT_GLOBAL_IPV6.check(address, 'ipv6');
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
