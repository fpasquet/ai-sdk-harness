import type {
  HarnessV1NetworkPolicy,
  HarnessV1NetworkSandboxSession,
  HarnessV1PortEndpoint,
  HarnessV1RequestTransformation,
} from '@ai-sdk/harness';
import type { Experimental_SandboxSession as SandboxSession } from '@ai-sdk/provider-utils';

import { HarnessCapabilityUnsupportedError } from '@ai-sdk/harness';
import { rm } from 'node:fs/promises';

import type { ForwardedPort } from '../network/port-forwarder.js';
import type { SandboxNetwork } from '../network/sandbox-network.js';
import type { SrtRuntime } from '../transport/srt-runtime.js';
import type { SrtSandboxHandle } from './srt-sandbox-session.js';

import { CredentialBroker } from '../network/credential-broker.js';
import { domainsOf } from '../network/network-policy.js';
import { forwardPort } from '../network/port-forwarder.js';
import { SRT_SANDBOX_PROVIDER_ID } from '../provider-id.js';
import { attempt } from '../utils/attempt.js';
import { SrtSandboxSession } from './srt-sandbox-session.js';

type Protocol = 'http' | 'https' | 'ws';

/** What the views of one sandbox share, beyond its files and processes. */
export interface SrtNetworkSandboxHandle extends SrtSandboxHandle {
  readonly runtime: SrtRuntime;
  readonly network: SandboxNetwork;
  /** The sandbox's own directory, removed by `destroy()`. */
  readonly root: string;
}

/** How a view of the sandbox deals with credentials. */
interface ViewSettings {
  /** Keep credentials out of the sandbox, swapped in by srt's proxy. */
  readonly brokerCredentials: boolean;
}

/** `url` with the scheme of `protocol`. */
function endpointUrl(url: string, protocol: Protocol): string {
  if (protocol === 'http') return url;
  return url.replace(/^http/, protocol === 'ws' ? 'ws' : 'https');
}

/**
 * The whole of an srt sandbox, as `HarnessAgent.createSession({ sandboxSession })` expects it:
 * files and processes, plus the ports a harness bridge listens on and the credentials the sandbox
 * must never see.
 *
 * - **Ports** are forwarded the first time the harness asks for them, to a free port of this host's
 *   loopback: the sandbox has a network of its own, reached through its supervisor.
 * - **Credentials** stay out of the sandbox. Each request transformation the harness asks for
 *   becomes a credential of srt's proxy: the sandbox holds a placeholder, and the proxy puts the
 *   real value in the requests to the transformation's host, which the sandbox may then reach.
 *
 * Obtain one from `createSrtNetworkSandboxSession()` or `resumeSrtNetworkSandboxSession()`.
 */
export class SrtNetworkSandboxSession
  extends SrtSandboxSession
  implements HarnessV1NetworkSandboxSession
{
  readonly id: string;
  readonly defaultWorkingDirectory: string;
  /** Absent when brokering is off: the harness then forwards the real credential instead. */
  readonly addRequestTransformations?: (
    transformations: ReadonlyArray<HarnessV1RequestTransformation>,
  ) => Promise<void>;
  /** Absent when brokering is off, like {@link addRequestTransformations}. */
  readonly setRequestTransformations?: (
    transformations: ReadonlyArray<HarnessV1RequestTransformation>,
  ) => Promise<void>;

  private exposed: readonly number[];
  private readonly broker: CredentialBroker;
  /** Sandbox port → where it is forwarded on this host. */
  private readonly forwarded = new Map<number, Promise<ForwardedPort>>();

  constructor(
    protected override readonly handle: SrtNetworkSandboxHandle,
    ports: readonly number[],
    private readonly settings: ViewSettings,
  ) {
    super(handle);
    this.id = handle.id;
    this.defaultWorkingDirectory = handle.workingDirectory;
    this.exposed = [...ports];
    this.broker = new CredentialBroker(handle.runtime, (hosts) =>
      handle.network.setCredentialHosts(this, hosts),
    );
    if (settings.brokerCredentials) {
      this.addRequestTransformations = (transformations) =>
        attempt(() => this.broker.add(transformations));
      this.setRequestTransformations = (transformations) =>
        attempt(() => this.broker.replace(transformations));
    }
  }

  /**
   * Another view of the same sandbox, with ports of its own. It shares the supervisor, the files
   * and the network policy, and nothing else: the processes it starts, the ports it forwards and the
   * credentials it registers are its own, and its {@link release} only touches them. What lets
   * several harness sessions, each with a bridge on its own port, run side by side in one sandbox.
   * `stop()` and `destroy()` act on the whole sandbox, every view included.
   */
  fork = ({ ports }: { ports: readonly number[] }): SrtNetworkSandboxSession =>
    new SrtNetworkSandboxSession({ ...this.handle, processes: new Set() }, ports, this.settings);

  /** Ports the sandbox exposes, resolvable with {@link getPortEndpoint}. */
  get ports(): readonly number[] {
    return this.exposed;
  }

  /** The hosts the sandbox may reach: its allowed hosts, and those its credentials go to. */
  get allowedDomains(): readonly string[] {
    return this.handle.network.domains;
  }

  /**
   * Whether the hosts this sandbox may reach are its own. With srt 0.0.79, srt's proxy has a single
   * allow list for the process: every sandbox may reach what any of them is allowed. The srt
   * release after it keeps a list per sandbox.
   */
  get isolatesNetwork(): boolean {
    return this.handle.runtime.isolatesNetworks;
  }

  restricted = (): SandboxSession => new SrtSandboxSession(this.handle);

  getPortEndpoint = async ({
    port,
    protocol = 'http',
  }: {
    port: number;
    protocol?: Protocol;
  }): Promise<HarnessV1PortEndpoint> => {
    if (!this.exposed.includes(port)) {
      throw new HarnessCapabilityUnsupportedError({
        harnessId: SRT_SANDBOX_PROVIDER_ID,
        message: `Port ${port} is not exposed by sandbox "${this.id}". Exposed ports: [${this.exposed.join(', ')}].`,
      });
    }
    let forwarded = this.forwarded.get(port);
    if (forwarded === undefined) {
      forwarded = forwardPort(port, async (target) =>
        (await this.handle.supervisor.link()).open({ kind: 'connect', port: target }),
      );
      this.forwarded.set(port, forwarded);
      forwarded.catch(() => this.forwarded.delete(port));
    }
    return { url: endpointUrl((await forwarded).url, protocol) };
  };

  /** @deprecated Use {@link getPortEndpoint}. */
  getPortUrl = async (options: { port: number; protocol?: Protocol }): Promise<string> =>
    (await this.getPortEndpoint(options)).url;

  /** Replaces the exposed ports; a port left out is no longer forwarded. */
  setPorts = async (ports: ReadonlyArray<number>): Promise<void> => {
    const removed = [...this.forwarded.keys()].filter((port) => !ports.includes(port));
    await Promise.all(removed.map((port) => this.unforward(port)));
    this.exposed = [...ports];
  };

  /**
   * Replaces the hosts the sandbox may reach, for every view: `deny-all`, or `custom` with
   * `allowedHosts` and single addresses. srt only allows what it lists: `allow-all` and ranges of
   * addresses are refused. The hosts the credentials go to stay reachable.
   */
  setNetworkPolicy = (policy: HarnessV1NetworkPolicy): Promise<void> =>
    attempt(() => this.handle.network.setAllowed(domainsOf(policy)));

  /**
   * Hands the sandbox back without stopping it: the processes this view started are stopped, its
   * ports no longer forwarded and its credentials withdrawn from srt's proxy. What an application
   * that keeps one sandbox across harness sessions calls between them.
   */
  release = async (): Promise<void> => {
    await this.killAll();
    await Promise.all([...this.forwarded.keys()].map((port) => this.unforward(port)));
    this.broker.release();
  };

  /**
   * Stops every process any view started in the sandbox. The supervisor stops them all when it
   * stops, so a sandbox resumed by another run of the application starts with none.
   */
  killAllProcesses = async (): Promise<void> => {
    const link = await this.handle.supervisor.link();
    await link.open({ kind: 'kill-all' }).closed;
    this.handle.processes.clear();
  };

  /**
   * Stops the sandbox, keeping its directory: its supervisor ends, with every process of every view.
   * The next call that needs it starts it again. Idempotent.
   */
  stop = async (): Promise<void> => {
    await this.release();
    await this.handle.supervisor.stop();
  };

  /** Stops the sandbox and removes its directory, its home and working directory included. */
  destroy = async (): Promise<void> => {
    await this.stop();
    await rm(this.handle.root, { recursive: true, force: true });
  };

  private async unforward(port: number): Promise<void> {
    const forwarded = await this.forwarded.get(port)?.catch(() => undefined);
    this.forwarded.delete(port);
    await forwarded?.close();
  }
}
