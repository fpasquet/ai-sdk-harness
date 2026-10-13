import type {
  HarnessV1NetworkSandboxSession,
  HarnessV1PortEndpoint,
  HarnessV1RequestTransformation,
} from '@ai-sdk/harness';
import type { Experimental_SandboxSession as SandboxSession } from '@ai-sdk/provider-utils';

import { HarnessCapabilityUnsupportedError } from '@ai-sdk/harness';

import type { CredentialBroker } from '../network/credential-broker.js';
import type { PortBinding } from '../transport/microsandbox-connection.js';
import type { MicrosandboxSandboxHandle } from './microsandbox-sandbox-session.js';

import { secretBroker } from '../network/credential-broker.js';
import { MICROSANDBOX_SANDBOX_PROVIDER_ID } from '../provider-id.js';
import { MicrosandboxSandboxSession } from './microsandbox-sandbox-session.js';

type Protocol = 'http' | 'https' | 'ws';

/**
 * The whole of a microsandbox, as `HarnessAgent.createSession({ sandboxSession })` expects it:
 * files and processes, plus the ports a harness bridge listens on and the credentials the sandbox
 * must never see.
 *
 * - **Ports** were published on this host's loopback when the sandbox was created.
 * - **Credentials** stay out of the sandbox. Each request transformation the harness asks for
 *   becomes a microsandbox secret: the sandbox only holds a placeholder, which microsandbox's
 *   network stack swaps for the real value in the requests to the API's host.
 *
 * Obtain one from `createMicrosandboxNetworkSandboxSession()` or
 * `resumeMicrosandboxNetworkSandboxSession()`.
 */
export class MicrosandboxNetworkSandboxSession
  extends MicrosandboxSandboxSession
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
  /** Sandbox port → the loopback port of this host it is published on. */
  private readonly published: ReadonlyMap<number, number>;

  constructor(
    handle: MicrosandboxSandboxHandle,
    ports: readonly PortBinding[],
    brokerCredentials: boolean,
  ) {
    super(handle);
    this.id = handle.connection.name;
    this.defaultWorkingDirectory = handle.workingDirectory;
    this.published = new Map(ports.map(({ guestPort, hostPort }) => [guestPort, hostPort]));
    this.exposed = [...this.published.keys()];
    this.broker = secretBroker(handle.connection);
    if (brokerCredentials) {
      this.addRequestTransformations = (transformations) => this.broker.add(transformations);
      this.setRequestTransformations = (transformations) => this.broker.replace(transformations);
    }
  }

  /** Ports the sandbox exposes, resolvable with {@link getPortEndpoint}. */
  get ports(): readonly number[] {
    return this.exposed;
  }

  restricted = (): SandboxSession => new MicrosandboxSandboxSession(this.handle);

  getPortEndpoint = ({
    port,
    protocol = 'http',
  }: {
    port: number;
    protocol?: Protocol;
  }): Promise<HarnessV1PortEndpoint> => {
    const hostPort = this.published.get(port);
    if (hostPort === undefined || !this.exposed.includes(port)) {
      return Promise.reject(
        new HarnessCapabilityUnsupportedError({
          harnessId: MICROSANDBOX_SANDBOX_PROVIDER_ID,
          message: `Port ${port} is not exposed by sandbox "${this.id}". Exposed ports: [${this.exposed.join(', ')}].`,
        }),
      );
    }
    // A loopback port speaks plain HTTP: `https` gets what there is.
    const scheme = protocol === 'ws' ? 'ws' : 'http';
    return Promise.resolve({ url: `${scheme}://127.0.0.1:${hostPort}` });
  };

  /** @deprecated Use {@link getPortEndpoint}. */
  getPortUrl = async (options: { port: number; protocol?: Protocol }): Promise<string> =>
    (await this.getPortEndpoint(options)).url;

  /**
   * Narrows the exposed ports. microsandbox publishes ports when it creates a sandbox only, so a
   * port it did not publish then is refused.
   */
  setPorts = (ports: ReadonlyArray<number>): Promise<void> => {
    const unpublished = ports.filter((port) => !this.published.has(port));
    if (unpublished.length > 0) {
      return Promise.reject(
        new HarnessCapabilityUnsupportedError({
          harnessId: MICROSANDBOX_SANDBOX_PROVIDER_ID,
          message: `Sandbox "${this.id}" was not created with port ${unpublished.join(', ')}: microsandbox publishes ports at creation only. Published ports: [${[...this.published.keys()].join(', ')}].`,
        }),
      );
    }
    this.exposed = [...ports];
    return Promise.resolve();
  };

  /**
   * Hands the sandbox back without stopping it: the processes this session started are stopped and
   * its secrets withdrawn. What an application that keeps one sandbox across harness sessions
   * calls between them.
   */
  release = async (): Promise<void> => {
    await this.killAll();
    await this.broker.release();
  };

  /**
   * Stops every process started in this sandbox through this session or its restricted views.
   * microsandbox ends a command when the process that started it goes away, so nothing a previous
   * run of the application started outlives it.
   */
  killAllProcesses = (): Promise<void> => this.killAll();

  /**
   * `release()`, then stops the microVM, keeping its disk: the next command starts it again.
   * Idempotent.
   */
  stop = async (): Promise<void> => {
    await this.release();
    await this.handle.connection.stop();
  };

  /** Removes the sandbox, with its disk and its secrets. Idempotent. */
  destroy = async (): Promise<void> => {
    await this.killAll();
    await this.handle.connection.destroy();
  };
}
