import type { DockerCli } from '../transport/docker-cli.js';

/** The ports the proxy listens on to forward a port of the sandbox, one after the other. */
export const FIRST_FORWARD_PORT = 40_000;

/** The network alias of the sandbox's container, which the proxy forwards to. */
export const SANDBOX_ALIAS = 'sandbox';

/** A port of the sandbox the proxy forwards from one of its own, published on this host. */
export interface PortForward {
  listen: number;
  host: string;
  port: number;
}

/** The forwards of `ports`: the proxy's `listen` port for each, in order. */
export function forwardsOf(ports: readonly number[]): PortForward[] {
  return ports.map((port, index) => ({
    listen: FIRST_FORWARD_PORT + index,
    host: SANDBOX_ALIAS,
    port,
  }));
}

/** The loopback port of this host Docker published the proxy's `listen` port on: its URL. */
export async function publishedUrl(cli: DockerCli, proxy: string, listen: number): Promise<string> {
  const published = await cli.check(['port', proxy, `${listen}/tcp`]);
  // One line per address, `127.0.0.1:49153`: the IPv4 one.
  const address = published
    .split('\n')
    .map((line) => line.trim())
    .find((line) => /^127\.0\.0\.1:\d+$/.test(line));
  if (address === undefined) {
    throw new Error(
      `Docker published no loopback port for ${proxy}:${listen}: ${published.trim()}`,
    );
  }
  return `http://${address}`;
}

/** `base`, an `http://` URL, for `protocol`: the forward carries any of them as it is. */
export function endpointUrl(base: string, protocol: 'http' | 'https' | 'ws'): string {
  return base.replace(/^http/, protocol);
}
