import type {
  HarnessV1NetworkPolicy,
  HarnessV1NetworkSandboxSession,
  HarnessV1PortEndpoint,
} from '@ai-sdk/harness';
import type { Experimental_SandboxSession as SandboxSession } from '@ai-sdk/provider-utils';

import { HarnessCapabilityUnsupportedError } from '@ai-sdk/harness';
import { rm } from 'node:fs/promises';

import type {
  DockerBlockedRequest,
  DockerBlockedRequestsOptions,
} from '../network/blocked-requests.js';
import type { PortForward } from '../network/port-forwards.js';
import type { DockerSandboxHandle } from './docker-sandbox-session.js';

import { blockedRequests } from '../network/blocked-requests.js';
import { writeNetworkPolicy } from '../network/network-policy.js';
import { endpointUrl, publishedUrl } from '../network/port-forwards.js';
import { DOCKER_ENGINE_SANDBOX_PROVIDER_ID } from '../provider-id.js';
import { KILL_ALL } from '../transport/sandbox-scripts.js';
import { DockerSandboxSession } from './docker-sandbox-session.js';

type Protocol = 'http' | 'https' | 'ws';

/** What a sandbox is made of besides its container: its proxy, its network, its state. */
export interface DockerSandboxResources {
  /** The egress proxy's container. */
  readonly proxy: string;
  /** The internal network of the sandbox and its proxy. */
  readonly network: string;
  /** Its directory of this host: the policy, the refused requests, its settings. */
  readonly stateDirectory: string;
  /** The ports of the sandbox, each with the proxy's port it is forwarded from. */
  readonly forwards: readonly PortForward[];
}

/**
 * The whole of a sandbox on Docker Engine, as `HarnessAgent.createSession({ sandboxSession })`
 * expects it: a container on an internal network, whose only way out is an egress proxy that lets
 * through the hosts of its network policy, read again at each connection.
 *
 * - **Ports** are forwarded by the proxy and published on this host's loopback, fixed at creation.
 * - **Credentials** are not brokered: the harness forwards them into the sandbox, where the agent
 *   can read them. Give the sandbox credentials it may hold.
 *
 * Obtain one from `createDockerNetworkSandboxSession()` or `resumeDockerNetworkSandboxSession()`.
 */
export class DockerNetworkSandboxSession
  extends DockerSandboxSession
  implements HarnessV1NetworkSandboxSession
{
  readonly id: string;
  readonly defaultWorkingDirectory: string;
  readonly ports: readonly number[];
  /** Sandbox port → its URL on this host's loopback. */
  private readonly published = new Map<number, Promise<string>>();

  constructor(
    handle: DockerSandboxHandle,
    private readonly resources: DockerSandboxResources,
  ) {
    super(handle);
    this.id = handle.name;
    this.defaultWorkingDirectory = handle.workingDirectory;
    this.ports = resources.forwards.map(({ port }) => port);
  }

  restricted = (): SandboxSession => new DockerSandboxSession(this.handle);

  getPortEndpoint = async ({
    port,
    protocol = 'http',
  }: {
    port: number;
    protocol?: Protocol;
  }): Promise<HarnessV1PortEndpoint> => {
    const forward = this.resources.forwards.find((candidate) => candidate.port === port);
    if (forward === undefined) {
      throw new HarnessCapabilityUnsupportedError({
        harnessId: DOCKER_ENGINE_SANDBOX_PROVIDER_ID,
        message: `Port ${port} is not exposed by sandbox "${this.id}". Exposed ports: [${this.ports.join(', ')}].`,
      });
    }
    let published = this.published.get(port);
    if (published === undefined) {
      published = publishedUrl(this.handle.cli, this.resources.proxy, forward.listen);
      this.published.set(port, published);
      published.catch(() => this.published.delete(port));
    }
    return { url: endpointUrl(await published, protocol) };
  };

  /** @deprecated Use {@link getPortEndpoint}. */
  getPortUrl = async (options: { port: number; protocol?: Protocol }): Promise<string> =>
    (await this.getPortEndpoint(options)).url;

  /**
   * Replaces what the sandbox may reach: the egress proxy reads the policy at each connection, so
   * that it applies to the next one, without a restart. CIDRs are refused.
   */
  setNetworkPolicy = async (policy: HarnessV1NetworkPolicy): Promise<void> => {
    await writeNetworkPolicy(this.resources.stateDirectory, policy);
  };

  /**
   * The requests the egress proxy refused to the sandbox, the last refused first: the host, the
   * port, when and why. Pass `since` to leave older refusals out.
   */
  blockedRequests = (options?: DockerBlockedRequestsOptions): Promise<DockerBlockedRequest[]> =>
    blockedRequests(this.resources.stateDirectory, options);

  /**
   * Hands the sandbox back without stopping it: the processes this session started are stopped.
   * What an application that keeps one sandbox across harness sessions calls between them.
   */
  release = async (): Promise<void> => {
    await this.killAll();
  };

  /**
   * Stops every process any session started in this sandbox, those a previous run of the
   * application left behind included, such as a harness bridge still holding its port.
   */
  killAllProcesses = async (): Promise<void> => {
    await this.handle.cli.check([...this.execArgs({}), 'sh', '-c', KILL_ALL]);
    this.handle.processes.clear();
  };

  /** Stops the sandbox and its proxy, keeping them for a resume. Idempotent. */
  stop = async (): Promise<void> => {
    await this.release().catch(() => undefined);
    this.published.clear();
    await this.handle.cli.run(['stop', '--time', '5', this.handle.name, this.resources.proxy]);
  };

  /** Removes the sandbox, its proxy, its network and its state on this host. Idempotent. */
  destroy = async (): Promise<void> => {
    this.handle.processes.clear();
    this.published.clear();
    await removeSandbox(this.handle.cli, {
      container: this.handle.name,
      ...this.resources,
    });
  };
}

/** Removes what a sandbox is made of, whatever is left of it. */
export async function removeSandbox(
  cli: DockerSandboxHandle['cli'],
  {
    container,
    proxy,
    network,
    stateDirectory,
  }: { container: string; proxy: string; network: string; stateDirectory: string },
): Promise<void> {
  await cli.run(['rm', '--force', '--volumes', container, proxy]);
  await cli.run(['network', 'rm', network]);
  await rm(stateDirectory, { recursive: true, force: true });
}
