import type { HarnessV1RequestTransformation } from '@ai-sdk/harness';

import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import type { Logger } from '../../common/logger.js';
import type { SandboxDescription, SandboxNetwork } from '../../protocol/api.js';
import type { KubernetesApi, SandboxResource } from '../kubernetes/kubernetes-api.js';
import type { AgentEndpoint } from './agent-client.js';
import type { ProxyAdmin } from './proxy-admin.js';

import { HttpError } from '../../common/http-error.js';
import { PACKAGE_VERSION } from '../../common/package-version.js';
import { PROTOCOL_VERSION } from '../../protocol/version.js';
import { KubernetesError } from '../kubernetes/kubernetes-error.js';
import { AgentClient, agentToken } from './agent-client.js';
import { type PodSettings, podSpec, VOLUME } from './pod-spec.js';

export type { PodSettings } from './pod-spec.js';

/** How the sandboxes are made: the service's to give. */
export interface SandboxesOptions {
  kubernetes: KubernetesApi;
  proxy: ProxyAdmin;
  logger: Logger;
  pod: PodSettings;
  /** Put before a sandbox's name to make its resource's: `sbx-`. */
  namePrefix: string;
  /** What the agents' tokens are derived from. */
  agentSecret: string;
  /** The port the agents listen on. */
  agentPort: number;
  /** Where the agent of a sandbox is reached: its pod's address by default. Tests only. */
  agentAddress?: (sandbox: SandboxResource) => { host: string; port: number };
  /** The egress proxy, as the pods reach it, by address: `http://10.8.0.12:3128`. */
  proxyUrl: () => Promise<string>;
  /** What every sandbox may reach, before what the caller adds. */
  network: Required<SandboxNetwork>;
  /** How long a pod has to be scheduled, pull its image and its agent to answer. */
  startTimeoutMs: number;
  /** How long a template's snapshot has to be cut. */
  snapshotTimeoutMs: number;
}

/** The label of the service's sandboxes and snapshots, and what each is. */
const LABEL = 'ai-sdk-sandbox';

/** The label naming the image a sandbox or a template was made on. */
const IMAGE_LABEL = 'ai-sdk-sandbox-image';

/** A name of a sandbox or a template: what a Kubernetes name and a URL path both take. */
const NAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/** How long the address of a running pod is trusted before it is read again. */
const ADDRESS_KEPT_MS = 5000;

/** The image a sandbox gets when its caller names none. */
export const DEFAULT_IMAGE = 'default';

/**
 * A sandbox's name ends up in its pod's host name and its volume's labels: 63 characters at most,
 * its volume's prefix aside.
 */
const MAX_NAME = 63 - VOLUME.length - 1;

function assertName(name: string, what: string, room: number): void {
  if (!NAME.test(name) || name.length > room) {
    throw new HttpError(
      400,
      `Invalid ${what} name "${name}": lowercase letters, digits and dashes, starting and ending with a letter or a digit, ${room} at most.`,
    );
  }
}

const conditionOf = (sandbox: SandboxResource, type: string) =>
  sandbox.status?.conditions?.find((condition) => condition.type === type);

/** Whether the pod of `sandbox` runs and its agent answers its readiness probe. */
const isReady = (sandbox: SandboxResource): boolean =>
  conditionOf(sandbox, 'Ready')?.status === 'True' && (sandbox.status?.podIPs?.length ?? 0) > 0;

/** Why the pod of `sandbox` is not up yet, in a few words, for an error. */
function whyNotReady(sandbox: SandboxResource): string {
  const scheduled = conditionOf(sandbox, 'PodScheduled');
  const blocking =
    scheduled?.status === 'False' ? scheduled : (conditionOf(sandbox, 'Ready') ?? scheduled);
  return blocking === undefined
    ? 'no status yet'
    : [blocking.reason, blocking.message].filter(Boolean).join(': ');
}

/**
 * The sandboxes, each a `Sandbox` of agent-sandbox: a pod of its own under gVisor, its home on a
 * volume of its own, named after it. The service keeps nothing of them: what a sandbox is,
 * Kubernetes says; what it may reach and its credentials, the egress proxy holds; its processes,
 * its agent runs. Any replica of the service serves any sandbox.
 */
export class Sandboxes {
  private readonly endpoints = new Map<string, { endpoint: AgentEndpoint; until: number }>();

  constructor(private readonly options: SandboxesOptions) {
    if (options.pod.images[DEFAULT_IMAGE] === undefined) {
      throw new Error(`The sandboxes need a "${DEFAULT_IMAGE}" image.`);
    }
    if (!/^[a-z][a-z0-9-]{0,7}$/.test(options.namePrefix)) {
      throw new Error(
        `The name prefix "${options.namePrefix}" must start with a letter and hold 8 lowercase letters, digits or dashes at most.`,
      );
    }
  }

  /** The agent of the running sandbox `name`. */
  async agent(name: string): Promise<AgentClient> {
    this.assertSandboxName(name);
    const cached = this.endpoints.get(name);
    if (cached !== undefined && Date.now() < cached.until) return new AgentClient(cached.endpoint);
    const sandbox = await this.sandboxOf(name);
    if (sandbox === undefined || !isReady(sandbox)) {
      throw new HttpError(404, `No sandbox "${name}" is running.`);
    }
    return new AgentClient(this.remember(name, sandbox));
  }

  /**
   * Creates the sandbox `name` on the image `image`, its home from its template `template` when
   * given. Never resumes one.
   */
  async create(
    name: string,
    {
      template,
      image = DEFAULT_IMAGE,
      ...network
    }: SandboxNetwork & { image?: string; template?: string },
  ): Promise<SandboxDescription> {
    this.assertSandboxName(name);
    const reference = this.imageOf(image);
    const resource = this.resourceName(name);
    if ((await this.options.kubernetes.getSandbox(resource)) !== undefined) {
      throw new HttpError(409, `A sandbox named "${name}" already exists.`);
    }
    const snapshot =
      template === undefined ? undefined : await this.templateSnapshot(template, image);
    const startedAt = Date.now();
    try {
      await this.options.kubernetes.createSandbox(
        this.sandboxBody(resource, { image, reference, snapshot }),
      );
    } catch (error) {
      if (error instanceof KubernetesError && error.status === 409) {
        throw new HttpError(409, `A sandbox named "${name}" already exists.`);
      }
      throw error;
    }
    try {
      const description = await this.ready(name, network);
      this.options.logger.info(`${name} created in ${Date.now() - startedAt} ms`);
      return description;
    } catch (error) {
      // Half-made, the sandbox would block a retry under the same name, and hold its node.
      await this.delete(name).catch(() => undefined);
      throw error;
    }
  }

  /**
   * The sandbox `name`, running, or its pod made again on its volume, the processes it ran gone.
   * Never creates one.
   */
  async resume(name: string, network: SandboxNetwork): Promise<SandboxDescription> {
    this.assertSandboxName(name);
    const sandbox = await this.sandboxOf(name);
    if (sandbox === undefined) {
      throw new HttpError(404, `No sandbox "${name}": it was never created, or it was deleted.`);
    }
    const startedAt = Date.now();
    if (sandbox.spec.operatingMode === 'Suspended') {
      await this.options.kubernetes.patchSandbox(sandbox.metadata.name, {
        spec: { operatingMode: 'Running' },
      });
    }
    const description = await this.ready(name, network);
    this.options.logger.info(`${name} resumed in ${Date.now() - startedAt} ms`);
    return description;
  }

  /**
   * Suspends the sandbox: its pod deleted, its volume kept, the proxy forgetting its credentials
   * first. Nothing runs, nothing is billed but the volume, until a resume. Idempotent.
   */
  async suspend(name: string): Promise<void> {
    this.assertSandboxName(name);
    const sandbox = await this.sandboxOf(name);
    if (sandbox === undefined) return;
    await this.forget(name);
    if (sandbox.spec.operatingMode !== 'Suspended') {
      await this.options.kubernetes.patchSandbox(sandbox.metadata.name, {
        spec: { operatingMode: 'Suspended' },
      });
      this.options.logger.info(`${name} suspended`);
    }
  }

  /** Deletes the sandbox, its pod and its volume. Idempotent. */
  async delete(name: string): Promise<void> {
    this.assertSandboxName(name);
    await this.forget(name);
    await this.options.kubernetes.deleteSandbox(this.resourceName(name));
    this.options.logger.info(`${name} deleted`);
  }

  /** Replaces the hosts the running sandbox `name` may reach, the service's own aside. */
  async setAllowedHosts(name: string, allowedHosts: readonly string[]): Promise<void> {
    this.assertSandboxName(name);
    await this.options.proxy.setAllowedHosts(name, this.allowedHosts(allowedHosts));
  }

  async addTransformations(
    name: string,
    transformations: readonly HarnessV1RequestTransformation[],
  ): Promise<void> {
    this.assertSandboxName(name);
    await this.options.proxy.addTransformations(name, transformations);
  }

  async setTransformations(
    name: string,
    transformations: readonly HarnessV1RequestTransformation[],
  ): Promise<void> {
    this.assertSandboxName(name);
    await this.options.proxy.setTransformations(name, transformations);
  }

  /**
   * Refuses a command that would carry into the sandbox one of the credentials the proxy holds for
   * it, on its command line or in its variables: they belong outside the sandbox, where the agent
   * cannot read them. A harness never does that; a mistake would.
   */
  async assertNoSecret(name: string, texts: readonly string[]): Promise<void> {
    if (await this.options.proxy.holdsSecret(name, texts)) {
      throw new HttpError(
        400,
        'A credential the proxy holds for this sandbox was about to enter it: refused. Credentials stay outside the sandbox.',
      );
    }
  }

  /**
   * Saves the home volume of the sandbox `name` as the template `id`, a snapshot new sandboxes'
   * volumes start from. The sandbox is suspended first, for a volume at rest: the caller deletes it
   * once the snapshot is cut.
   */
  async saveTemplate(name: string, id: string): Promise<void> {
    this.assertSandboxName(name);
    const sandbox = await this.sandboxOf(name);
    if (sandbox === undefined) throw new HttpError(404, `No sandbox "${name}".`);
    // The template is made on the image the builder ran.
    const base = sandbox.metadata.labels?.[IMAGE_LABEL] ?? DEFAULT_IMAGE;
    const snapshot = this.snapshotName(id, base);
    await this.suspend(name);
    await this.waitForSuspension(name);
    try {
      await this.options.kubernetes.createSnapshot({
        apiVersion: 'snapshot.storage.k8s.io/v1',
        kind: 'VolumeSnapshot',
        metadata: {
          name: snapshot,
          labels: {
            [LABEL]: 'template',
            [IMAGE_LABEL]: base,
            [`${LABEL}-base`]: this.namespace(base),
          },
        },
        spec: {
          ...(this.options.pod.snapshotClassName === undefined
            ? {}
            : { volumeSnapshotClassName: this.options.pod.snapshotClassName }),
          source: { persistentVolumeClaimName: `${VOLUME}-${sandbox.metadata.name}` },
        },
      });
    } catch (error) {
      // Another process saved the same template meanwhile: it is as good.
      if (!(error instanceof KubernetesError && error.status === 409)) throw error;
    }
    await this.waitForSnapshot(snapshot);
    this.options.logger.info(`${name} saved as the template ${id}`);
  }

  /** Whether the template `id` exists, made on the image `image`, and is ready to start from. */
  async templateExists(id: string, image = DEFAULT_IMAGE): Promise<boolean> {
    const found = await this.options.kubernetes.getSnapshot(this.snapshotName(id, image));
    return found?.status?.readyToUse === true;
  }

  async deleteTemplate(id: string, image = DEFAULT_IMAGE): Promise<void> {
    await this.options.kubernetes.deleteSnapshot(this.snapshotName(id, image));
  }

  /** The resource of the sandbox `name`: `undefined` when there is none, or one not the service's. */
  private async sandboxOf(name: string): Promise<SandboxResource | undefined> {
    const sandbox = await this.options.kubernetes.getSandbox(this.resourceName(name));
    return sandbox?.metadata.labels?.[LABEL] === 'sandbox' ? sandbox : undefined;
  }

  /** The sandbox `name` once its pod is ready: refused when it fails or takes too long. */
  private async waitForPod(name: string): Promise<SandboxResource> {
    const deadline = Date.now() + this.options.startTimeoutMs;
    for (;;) {
      const sandbox = await this.sandboxOf(name);
      if (sandbox === undefined || sandbox.metadata.deletionTimestamp !== undefined) {
        throw new HttpError(404, `The sandbox "${name}" was deleted meanwhile.`);
      }
      if (isReady(sandbox)) return sandbox;
      if (conditionOf(sandbox, 'Finished')?.status === 'True') {
        throw new HttpError(503, `The pod of "${name}" stopped: ${whyNotReady(sandbox)}.`);
      }
      if (Date.now() > deadline) {
        throw new HttpError(
          504,
          `The pod of "${name}" was not ready within ${this.options.startTimeoutMs / 1000} s (${whyNotReady(sandbox)}): check that its image runs \`ai-sdk-sandbox-gke agent\` and that the cluster has room for it.`,
        );
      }
      await sleep(1000);
    }
  }

  /** Waits until the pod of the suspended sandbox `name` is gone: its volume then at rest. */
  private async waitForSuspension(name: string): Promise<void> {
    const deadline = Date.now() + this.options.startTimeoutMs;
    for (;;) {
      const sandbox = await this.sandboxOf(name);
      if (sandbox === undefined || conditionOf(sandbox, 'Suspended')?.status === 'True') return;
      if (Date.now() > deadline) {
        throw new HttpError(504, `The pod of "${name}" did not stop: ${whyNotReady(sandbox)}.`);
      }
      await sleep(1000);
    }
  }

  private async waitForSnapshot(name: string): Promise<void> {
    const deadline = Date.now() + this.options.snapshotTimeoutMs;
    for (;;) {
      const snapshot = await this.options.kubernetes.getSnapshot(name);
      if (snapshot?.status?.readyToUse === true) return;
      const failure = snapshot?.status?.error?.message;
      if (failure !== undefined)
        throw new HttpError(502, `The snapshot ${name} failed: ${failure}`);
      if (Date.now() > deadline) {
        throw new HttpError(
          504,
          `The snapshot ${name} was not ready within ${this.options.snapshotTimeoutMs / 1000} s.`,
        );
      }
      await sleep(2000);
    }
  }

  /**
   * Makes the running sandbox `name` ready for commands: its pod ready, registered with the egress
   * proxy under its address, its agent answering and configured.
   */
  private async ready(name: string, network: SandboxNetwork): Promise<SandboxDescription> {
    const sandbox = await this.waitForPod(name);
    const [address = ''] = sandbox.status?.podIPs ?? [];
    const endpoint = this.remember(name, sandbox);
    const baseUrls = { ...this.options.network.baseUrls, ...network.baseUrls };
    await this.options.proxy.register(name, {
      address,
      allowedHosts: this.allowedHosts(network.allowedHosts ?? []),
      baseUrls,
    });
    const agent = new AgentClient(endpoint);
    await this.waitForAgent(name, agent);
    const { home, workingDirectory } = await agent.configure({
      proxy: await this.options.proxyUrl(),
      baseUrls,
    });
    return { name, home, workingDirectory };
  }

  /** The pod's readiness probe already found the agent: this checks it speaks this protocol. */
  private async waitForAgent(name: string, agent: AgentClient): Promise<void> {
    const deadline = Date.now() + this.options.startTimeoutMs;
    for (;;) {
      const protocol = await agent.health();
      if (protocol === PROTOCOL_VERSION) return;
      if (protocol !== undefined) {
        throw new HttpError(
          502,
          `The agent of "${name}" speaks protocol ${protocol} of ai-sdk-sandbox-gke, this service ${PROTOCOL_VERSION} (version ${PACKAGE_VERSION}): build the sandbox image with the version of the package the service runs.`,
        );
      }
      if (Date.now() > deadline) {
        throw new HttpError(
          504,
          `The agent of "${name}" did not answer the service: check that the network policy lets the service reach port ${this.options.agentPort} of the sandboxes.`,
        );
      }
      await sleep(1000);
    }
  }

  private async forget(name: string): Promise<void> {
    this.endpoints.delete(name);
    await this.options.proxy.remove(name).catch((error: unknown) => {
      this.options.logger.warn(`The proxy could not forget ${name}: ${String(error)}`);
    });
  }

  private remember(name: string, sandbox: SandboxResource): AgentEndpoint {
    const { host, port } = this.options.agentAddress?.(sandbox) ?? {
      host: sandbox.status?.podIPs?.[0] ?? '',
      port: this.options.agentPort,
    };
    const token = agentToken(this.options.agentSecret, sandbox.metadata.name);
    const endpoint = { host, port, token };
    this.endpoints.set(name, { endpoint, until: Date.now() + ADDRESS_KEPT_MS });
    return endpoint;
  }

  private allowedHosts(extra: readonly string[]): string[] {
    return [...new Set([...this.options.network.allowedHosts, ...extra])];
  }

  private resourceName(name: string): string {
    return `${this.options.namePrefix}${name}`;
  }

  private assertSandboxName(name: string): void {
    assertName(name, 'sandbox', MAX_NAME - this.options.namePrefix.length);
  }

  /** The container image callers name `image`: refused unless the service offers it. */
  private imageOf(image: string): string {
    const reference = this.options.pod.images[image];
    if (reference === undefined) {
      const offered = Object.keys(this.options.pod.images).join(', ');
      throw new HttpError(400, `No image "${image}" on this service. It offers: ${offered}.`);
    }
    return reference;
  }

  /** The snapshot of a template: its id, then what the templates are made on. */
  private snapshotName(id: string, image: string): string {
    assertName(id, 'template', 63 - 9);
    return `${id}-${this.namespace(image)}`;
  }

  private async templateSnapshot(id: string, image: string): Promise<string> {
    if (!(await this.templateExists(id, image))) {
      throw new HttpError(404, `No template "${id}" on the image "${image}".`);
    }
    return this.snapshotName(id, image);
  }

  /**
   * What the templates of `image` are made on: this package and the image's reference. A template
   * is only ever used on the image it was made on: after a new image, the first sandbox makes the
   * template again. A tag that moves keeps its templates: name images by digest to avoid it.
   */
  private namespace(image: string): string {
    return createHash('sha256')
      .update(JSON.stringify([PACKAGE_VERSION, this.imageOf(image)]))
      .digest('hex')
      .slice(0, 8);
  }

  private sandboxBody(
    name: string,
    { image, reference, snapshot }: { image: string; reference: string; snapshot?: string },
  ): Record<string, unknown> {
    const labels = { [LABEL]: 'sandbox', [IMAGE_LABEL]: image };
    return {
      apiVersion: 'agents.x-k8s.io/v1beta1',
      kind: 'Sandbox',
      metadata: { name, labels },
      spec: {
        operatingMode: 'Running',
        service: false,
        podTemplate: {
          metadata: { labels },
          spec: podSpec(this.options.pod, {
            image: reference,
            agentPort: this.options.agentPort,
            agentToken: agentToken(this.options.agentSecret, name),
          }),
        },
        volumeClaimTemplates: [
          {
            metadata: { name: VOLUME, labels: { [LABEL]: 'sandbox' } },
            spec: {
              accessModes: ['ReadWriteOnce'],
              ...(this.options.pod.storageClassName === undefined
                ? {}
                : { storageClassName: this.options.pod.storageClassName }),
              resources: { requests: { storage: this.options.pod.volumeSize } },
              ...(snapshot === undefined
                ? {}
                : {
                    dataSource: {
                      apiGroup: 'snapshot.storage.k8s.io',
                      kind: 'VolumeSnapshot',
                      name: snapshot,
                    },
                  }),
            },
          },
        ],
      },
    };
  }
}
