import type {
  HarnessV1NetworkPolicy,
  HarnessV1NetworkSandboxSession,
  HarnessV1PortEndpoint,
  HarnessV1RequestTransformation,
} from '@ai-sdk/harness';
import type { Experimental_SandboxSession as SandboxSession } from '@ai-sdk/provider-utils';

import { HarnessCapabilityUnsupportedError } from '@ai-sdk/harness';

import type { CloudRunSandboxHandle } from './cloud-run-sandbox-session.js';

import { CloudRunSandboxSession } from './cloud-run-sandbox-session.js';
import { CLOUD_RUN_SANDBOX_PROVIDER_ID } from './sandbox-service-client.js';

export { CLOUD_RUN_SANDBOX_PROVIDER_ID } from './sandbox-service-client.js';

type Protocol = 'http' | 'https' | 'ws';
type Transformations = ReadonlyArray<HarnessV1RequestTransformation>;

/** The hosts a network policy allows: CIDRs have no meaning to a proxy that only sees names. */
function allowedHostsOf(policy: HarnessV1NetworkPolicy): readonly string[] {
  if (policy.mode === 'allow-all') return ['*'];
  if (policy.mode === 'deny-all') return [];
  if ((policy.allowedCIDRs?.length ?? 0) > 0 || (policy.deniedCIDRs?.length ?? 0) > 0) {
    throw new HarnessCapabilityUnsupportedError({
      harnessId: CLOUD_RUN_SANDBOX_PROVIDER_ID,
      message:
        'A Cloud Run sandbox reaches the network through an HTTPS proxy that allows host names: CIDR rules are not supported.',
    });
  }
  return policy.allowedHosts ?? [];
}

/**
 * The whole of a Cloud Run sandbox, as `HarnessAgent.createSession({ sandboxSession })` expects it:
 * files and processes, plus the ports a harness bridge listens on and the credentials the sandbox
 * must never see.
 *
 * - **Ports** are reached through the sandbox service: a WebSocket to the service is passed on to
 *   the port, in the sandbox, without the identity token that let it through.
 * - **Credentials** stay out of the sandbox. The harness hands the sandbox a placeholder and asks
 *   for request transformations: the service keeps them in memory and swaps the placeholder for the
 *   real value on the request's way out, to a base URL.
 *
 * Obtain one from `createCloudRunNetworkSandboxSession()` or `resumeCloudRunNetworkSandboxSession()`.
 */
export class CloudRunNetworkSandboxSession
  extends CloudRunSandboxSession
  implements HarnessV1NetworkSandboxSession
{
  readonly defaultWorkingDirectory: string;
  readonly id: string;
  private exposed: readonly number[];

  constructor(handle: CloudRunSandboxHandle, ports: readonly number[]) {
    super(handle);
    this.id = handle.name;
    this.defaultWorkingDirectory = handle.workingDirectory;
    this.exposed = [...ports];
  }

  /**
   * Hands credentials to the service, which puts them in the requests on their way out to a base
   * URL. Always there: a harness then never forwards a real credential into the sandbox, where
   * the agent could read it.
   */
  addRequestTransformations = (transformations: Transformations): Promise<void> =>
    this.handle.client.addTransformations(this.handle.name, transformations);

  /** Replaces every credential the service holds for the sandbox. */
  setRequestTransformations = (transformations: Transformations): Promise<void> =>
    this.handle.client.setTransformations(this.handle.name, transformations);

  /** Ports the sandbox exposes, resolvable with {@link getPortEndpoint}. */
  get ports(): readonly number[] {
    return this.exposed;
  }

  restricted = (): SandboxSession => new CloudRunSandboxSession(this.handle);

  getPortEndpoint = ({
    port,
    protocol = 'http',
  }: {
    port: number;
    protocol?: Protocol;
  }): Promise<HarnessV1PortEndpoint> => {
    if (!this.exposed.includes(port)) {
      return Promise.reject(
        new HarnessCapabilityUnsupportedError({
          harnessId: CLOUD_RUN_SANDBOX_PROVIDER_ID,
          message: `Port ${port} is not exposed by sandbox "${this.id}". Exposed ports: [${this.exposed.join(', ')}].`,
        }),
      );
    }
    return Promise.resolve(this.handle.client.portEndpoint(this.handle.name, port, protocol));
  };

  /** @deprecated Use {@link getPortEndpoint}. */
  getPortUrl = async (options: { port: number; protocol?: Protocol }): Promise<string> =>
    (await this.getPortEndpoint(options)).url;

  /** Replaces the exposed ports. */
  setPorts = (ports: ReadonlyArray<number>): Promise<void> => {
    this.exposed = [...ports];
    return Promise.resolve();
  };

  /**
   * Replaces the hosts the sandbox may reach: `allow-all` lets it reach any host over HTTPS,
   * `deny-all` none. The hosts the service allows every sandbox, and the base URLs, stay reachable.
   */
  setNetworkPolicy = async (policy: HarnessV1NetworkPolicy): Promise<void> => {
    await this.handle.client.setAllowedHosts(this.handle.name, allowedHostsOf(policy));
  };

  /**
   * Hands the sandbox back without stopping it: the processes this session started are stopped
   * and its credentials forgotten by the service. What an application that keeps one sandbox
   * across harness sessions calls between them.
   */
  release = async (): Promise<void> => {
    await this.killAll();
    await this.handle.client.setTransformations(this.handle.name, []);
  };

  /**
   * Stops every process any session started in this sandbox, including those a previous run of the
   * application left behind, such as a harness bridge still holding its port. Call it right after
   * resuming a sandbox no other process uses.
   */
  killAllProcesses = async (): Promise<void> => {
    await this.handle.client.killAll(this.handle.name);
    this.handle.processes.clear();
  };

  /**
   * Suspends the sandbox: what this session runs is stopped, then the sandbox's filesystem is saved
   * to its snapshot and the sandbox freed, with the credentials the service held for it. Nothing
   * runs, nothing is billed but the snapshot's storage, until a resume brings it back. Idempotent.
   */
  stop = async (): Promise<void> => {
    await this.killAll();
    await this.handle.client.suspend(this.handle.name);
  };

  /** Deletes the sandbox and its snapshot. Idempotent. */
  destroy = async (): Promise<void> => {
    await this.killAll().catch(() => undefined);
    await this.handle.client.remove(this.handle.name);
  };
}
