import type {
  HarnessV1NetworkPolicy,
  HarnessV1NetworkSandboxSession,
  HarnessV1PortEndpoint,
  HarnessV1RequestTransformation,
} from '@ai-sdk/harness';
import type { Experimental_SandboxSession as SandboxSession } from '@ai-sdk/provider-utils';

import { HarnessCapabilityUnsupportedError } from '@ai-sdk/harness';

import type { GkeSandboxHandle } from './gke-sandbox-session.js';

import { GKE_SANDBOX_PROVIDER_ID } from '../provider-id.js';
import { GkeSandboxSession } from './gke-sandbox-session.js';

type Protocol = 'http' | 'https' | 'ws';
type Transformations = ReadonlyArray<HarnessV1RequestTransformation>;

/** Where a view stands among the views of one sandbox. */
interface ViewSettings {
  /**
   * The credentials each view handed to the service, which holds them all for the sandbox: what
   * the views of one sandbox share.
   */
  readonly credentials?: Map<GkeNetworkSandboxSession, Transformations>;
  /** Whether this is a view made by `fork()`, which never withdraws the credentials of others. */
  readonly forked?: boolean;
}

/** The hosts a network policy allows: CIDRs have no meaning to a proxy that only sees names. */
function allowedHostsOf(policy: HarnessV1NetworkPolicy): readonly string[] {
  if (policy.mode === 'allow-all') return ['*'];
  if (policy.mode === 'deny-all') return [];
  if ((policy.allowedCIDRs?.length ?? 0) > 0 || (policy.deniedCIDRs?.length ?? 0) > 0) {
    throw new HarnessCapabilityUnsupportedError({
      harnessId: GKE_SANDBOX_PROVIDER_ID,
      message:
        'A GKE sandbox reaches the network through an HTTPS proxy that allows host names: CIDR rules are not supported.',
    });
  }
  return policy.allowedHosts ?? [];
}

/**
 * The whole of a GKE sandbox, as `HarnessAgent.createSession({ sandboxSession })` expects it:
 * files and processes, plus the ports a harness bridge listens on and the credentials the sandbox
 * must never see.
 *
 * - **Ports** are reached through the sandbox service: a WebSocket to the service is passed on to
 *   the port, in the sandbox, without the identity token that let it through.
 * - **Credentials** stay out of the sandbox. The harness hands the sandbox a placeholder and asks
 *   for request transformations: the service keeps them in memory and swaps the placeholder for the
 *   real value on the request's way out, to a base URL.
 *
 * Obtain one from `createGkeNetworkSandboxSession()` or `resumeGkeNetworkSandboxSession()`.
 */
export class GkeNetworkSandboxSession
  extends GkeSandboxSession
  implements HarnessV1NetworkSandboxSession
{
  readonly defaultWorkingDirectory: string;
  readonly id: string;
  private exposed: readonly number[];

  private readonly view: Required<ViewSettings>;

  constructor(handle: GkeSandboxHandle, ports: readonly number[], view: ViewSettings = {}) {
    super(handle);
    this.id = handle.name;
    this.defaultWorkingDirectory = handle.workingDirectory;
    this.exposed = [...ports];
    this.view = { credentials: new Map(), forked: false, ...view };
  }

  /**
   * Another view of the same sandbox, with ports of its own. It shares the sandbox, its files and
   * the service that runs it, and nothing else: the processes it starts and the credentials it
   * hands to the service are its own, and its {@link release} only touches them. What lets several
   * harness sessions, each with a bridge on its own port, run side by side in one sandbox.
   *
   * Its `setRequestTransformations` replaces its own credentials only. `stop()` and `destroy()` act
   * on the whole sandbox, every view included.
   */
  fork = ({ ports }: { ports: readonly number[] }): GkeNetworkSandboxSession =>
    new GkeNetworkSandboxSession({ ...this.handle, processes: new Set() }, ports, {
      credentials: this.view.credentials,
      forked: true,
    });

  /**
   * Hands credentials to the service, which puts them in the requests on their way out to a base
   * URL. Always there: a harness then never forwards a real credential into the sandbox, where
   * the agent could read it.
   */
  addRequestTransformations = async (transformations: Transformations): Promise<void> => {
    const { credentials } = this.view;
    credentials.set(this, [...(credentials.get(this) ?? []), ...transformations]);
    await this.handle.client.addTransformations(this.handle.name, transformations);
  };

  /**
   * Replaces every credential the service holds for the sandbox; on a view made by {@link fork},
   * the credentials of that view only.
   */
  setRequestTransformations = async (transformations: Transformations): Promise<void> => {
    if (!this.view.forked) this.view.credentials.clear();
    this.view.credentials.set(this, transformations);
    await this.syncCredentials();
  };

  /** Ports the sandbox exposes, resolvable with {@link getPortEndpoint}. */
  get ports(): readonly number[] {
    return this.exposed;
  }

  restricted = (): SandboxSession => new GkeSandboxSession(this.handle);

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
          harnessId: GKE_SANDBOX_PROVIDER_ID,
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
    this.view.credentials.delete(this);
    await this.syncCredentials();
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
   * Suspends the sandbox: what this session runs is stopped, the proxy forgets the credentials it
   * held for it, then its pod is deleted, its home volume kept. Nothing runs, nothing is billed but
   * the volume, until a resume makes the pod again. Idempotent.
   */
  stop = async (): Promise<void> => {
    await this.killAll();
    await this.handle.client.suspend(this.handle.name);
  };

  /** Deletes the sandbox's pod and its volume. Idempotent. */
  destroy = async (): Promise<void> => {
    await this.killAll().catch(() => undefined);
    await this.handle.client.remove(this.handle.name);
  };

  /** Hands the service the credentials every view of the sandbox still holds. */
  private async syncCredentials(): Promise<void> {
    const held = [...this.view.credentials.values()].flat();
    await this.handle.client.setTransformations(this.handle.name, held);
  }
}
