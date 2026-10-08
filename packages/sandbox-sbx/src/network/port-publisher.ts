import type { SbxCli } from '../transport/sbx-cli.js';

import { freeLoopbackPort } from './free-loopback-port.js';

/** A sandbox port made reachable from this process. */
export interface PublishedPort {
  /** Where it is reached: `http://127.0.0.1:<port>` locally, a public `https://` URL in the cloud. */
  readonly url: string;
  /** What `sbx ports --unpublish` takes to withdraw it. */
  readonly binding: string;
}

/** How a sandbox port becomes reachable: on this host's loopback, or through the cloud. */
export interface PortPublisher {
  publish(port: number): Promise<PublishedPort>;
  unpublish(published: PublishedPort): Promise<void>;
}

const URL_PATTERN = /^https?:\/\//;

/**
 * Local sandboxes: each port is published on this host's loopback only, on a free port picked here
 * rather than by `sbx`, since an ephemeral binding comes back under another port once unpublished.
 */
export function loopbackPorts(cli: SbxCli, sandbox: string): PortPublisher {
  return {
    publish: async (port) => {
      const hostPort = await freeLoopbackPort();
      const binding = `127.0.0.1:${hostPort}:${port}`;
      await cli.check(['ports', sandbox, '--publish', binding]);
      return { url: `http://127.0.0.1:${hostPort}`, binding };
    },
    unpublish: async ({ binding }) => {
      await cli.run(['ports', sandbox, '--unpublish', binding]);
    },
  };
}

/**
 * Cloud sandboxes: the control plane exposes the port and assigns it a public URL, read back from
 * the port listing, or from what publishing printed when the listing does not carry it.
 */
export function cloudPorts(cli: SbxCli, sandbox: string): PortPublisher {
  return {
    publish: async (port) => {
      const printed = await cli.check(['ports', sandbox, '--publish', String(port)]);
      const listed = await cli.check(['ports', sandbox, '--json']);
      const url = findPortUrl(parseJson(listed), port) ?? printed.match(/https?:\/\/\S+/)?.[0];
      if (url === undefined) {
        throw new Error(
          `sbx exposed port ${port} of the cloud sandbox "${sandbox}" without saying at which URL.`,
        );
      }
      return { url: url.replace(/\/$/, ''), binding: String(port) };
    },
    unpublish: async ({ binding }) => {
      await cli.run(['ports', sandbox, '--unpublish', binding]);
    },
  };
}

/** The URL to reach `base` with `protocol`, keeping it secure when the base is. */
export function endpointUrl(base: string, protocol: 'http' | 'https' | 'ws'): string {
  const secure = base.startsWith('https:');
  const scheme = protocol === 'ws' ? (secure ? 'wss' : 'ws') : secure ? 'https' : 'http';
  return base.replace(/^https?/, scheme);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * The URL of `port` in a port listing, whatever its exact shape: the first object that names the
 * port in a `*port*` field and carries an `http(s)` URL.
 */
export function findPortUrl(listing: unknown, port: number): string | undefined {
  if (Array.isArray(listing)) {
    for (const item of listing) {
      const url = findPortUrl(item, port);
      if (url !== undefined) return url;
    }
    return undefined;
  }
  if (typeof listing !== 'object' || listing === null) return undefined;
  const entries = Object.entries(listing as Record<string, unknown>);
  const namesPort = entries.some(([key, value]) => /port/i.test(key) && Number(value) === port);
  const url = entries.find(([, value]) => typeof value === 'string' && URL_PATTERN.test(value));
  if (namesPort && url) return url[1] as string;
  return findPortUrl(
    entries.map(([, value]) => value).filter((value) => typeof value === 'object'),
    port,
  );
}
