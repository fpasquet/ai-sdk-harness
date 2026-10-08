import type {
  HarnessV1NetworkSandboxSession,
  HarnessV1PortEndpoint,
  HarnessV1RequestTransformation,
} from '@ai-sdk/harness';
import type { Experimental_SandboxSession as SandboxSession } from '@ai-sdk/provider-utils';

import { HarnessCapabilityUnsupportedError } from '@ai-sdk/harness';

import type { CredentialBroker } from '../network/credential-broker.js';
import type { PortPublisher, PublishedPort } from '../network/port-publisher.js';
import type { SbxSandboxHandle } from './sbx-sandbox-session.js';

import { headerBroker, placeholderBroker } from '../network/credential-broker.js';
import { cloudPorts, endpointUrl, loopbackPorts } from '../network/port-publisher.js';
import { SBX_SANDBOX_PROVIDER_ID } from '../provider-id.js';
import { KILL_ALL } from '../transport/sandbox-scripts.js';
import { SbxSandboxSession } from './sbx-sandbox-session.js';

type Protocol = 'http' | 'https' | 'ws';

/**
 * The whole of a Docker Sandbox, as `HarnessAgent.createSession({ sandboxSession })` expects it:
 * files and processes, plus the ports a harness bridge listens on and the credentials the sandbox
 * must never see.
 *
 * - **Ports** are published the first time the harness asks for them: on this host's loopback for
 *   a local sandbox, at the public URL the control plane assigns for a cloud one.
 * - **Credentials** stay out of the sandbox. Each request transformation the harness asks for
 *   becomes a custom secret of the Docker Sandboxes proxy, scoped to this sandbox: the value only
 *   exists on the host and in the proxy.
 *
 * Obtain one from `createSbxNetworkSandboxSession()` or `resumeSbxNetworkSandboxSession()`.
 */
export class SbxNetworkSandboxSession
  extends SbxSandboxSession
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

  /** Whether the sandbox runs in Docker Sandboxes Cloud rather than on this host. */
  readonly cloud: boolean;

  private exposed: readonly number[];
  private readonly broker: CredentialBroker;
  private readonly publisher: PortPublisher;
  /** Sandbox port → where it is published. */
  private readonly published = new Map<number, Promise<PublishedPort>>();

  constructor(handle: SbxSandboxHandle, ports: readonly number[], brokerCredentials: boolean) {
    super(handle);
    this.id = handle.name;
    this.defaultWorkingDirectory = handle.workingDirectory;
    this.cloud = handle.cli.cloud;
    this.exposed = [...ports];
    this.broker = this.cloud
      ? headerBroker(handle.cli, handle.name)
      : placeholderBroker(handle.cli, handle.name);
    this.publisher = this.cloud
      ? cloudPorts(handle.cli, handle.name)
      : loopbackPorts(handle.cli, handle.name);
    if (brokerCredentials) {
      this.addRequestTransformations = (transformations) => this.broker.add(transformations);
      this.setRequestTransformations = async (transformations) => {
        await this.broker.clear();
        await this.broker.add(transformations);
      };
    }
  }

  /** Ports the sandbox exposes, resolvable with {@link getPortEndpoint}. */
  get ports(): readonly number[] {
    return this.exposed;
  }

  restricted = (): SandboxSession => new SbxSandboxSession(this.handle);

  getPortEndpoint = async ({
    port,
    protocol = 'http',
  }: {
    port: number;
    protocol?: Protocol;
  }): Promise<HarnessV1PortEndpoint> => {
    if (!this.exposed.includes(port)) {
      throw new HarnessCapabilityUnsupportedError({
        harnessId: SBX_SANDBOX_PROVIDER_ID,
        message: `Port ${port} is not exposed by sandbox "${this.id}". Exposed ports: [${this.exposed.join(', ')}].`,
      });
    }
    let published = this.published.get(port);
    if (published === undefined) {
      published = this.publisher.publish(port);
      this.published.set(port, published);
      published.catch(() => this.published.delete(port));
    }
    return { url: endpointUrl((await published).url, protocol) };
  };

  /** @deprecated Use {@link getPortEndpoint}. */
  getPortUrl = async (options: { port: number; protocol?: Protocol }): Promise<string> =>
    (await this.getPortEndpoint(options)).url;

  /** Replaces the exposed ports; a port left out is unpublished. */
  setPorts = async (ports: ReadonlyArray<number>): Promise<void> => {
    const removed = [...this.published.keys()].filter((port) => !ports.includes(port));
    await Promise.all(removed.map((port) => this.unpublish(port)));
    this.exposed = [...ports];
  };

  /**
   * Hands the sandbox back without stopping it: the processes this session started are stopped,
   * its ports unpublished and its secrets withdrawn from the proxy. What an application that
   * keeps one sandbox across harness sessions calls between them.
   */
  release = async (): Promise<void> => {
    await this.killAll();
    await Promise.all([...this.published.keys()].map((port) => this.unpublish(port)));
    await this.broker.release();
  };

  /**
   * Stops every process any session started in this sandbox, including those a previous run of the
   * application left behind, such as a harness bridge still holding its port. Call it right after
   * resuming a sandbox no other process uses.
   */
  killAllProcesses = async (): Promise<void> => {
    await this.handle.cli.check([...this.execArgs({}), 'sh', '-c', KILL_ALL]);
    this.handle.processes.clear();
  };

  /**
   * Extends the time-to-live of a cloud sandbox by `duration` (`30m`, `2h`), within the 24 hours
   * after its creation the platform allows. Local sandboxes have no time-to-live.
   */
  extendTtl = async (duration: string): Promise<void> => {
    if (!this.cloud) throw new Error('Only a cloud sandbox has a time-to-live to extend.');
    await this.handle.cli.check(['ttl', `+${duration}`, this.handle.name]);
  };

  /**
   * Stops the sandbox, keeping it for the next `sbx exec`: a local microVM keeps its filesystem, a
   * cloud one is suspended with its memory. Idempotent.
   */
  stop = async (): Promise<void> => {
    await this.release();
    await this.handle.cli.run(['stop', this.handle.name]);
  };

  /** Removes the sandbox, with its filesystem and the secrets scoped to it. Idempotent. */
  destroy = async (): Promise<void> => {
    await this.killAll();
    this.published.clear();
    await this.handle.cli.run(['rm', '--force', this.handle.name]);
    // A local sandbox takes its secrets with it; a cloud secret is the account's, until removed.
    if (this.cloud) await this.broker.release();
  };

  private async unpublish(port: number): Promise<void> {
    const published = await this.published.get(port)?.catch(() => undefined);
    this.published.delete(port);
    if (published !== undefined) await this.publisher.unpublish(published);
  }
}
