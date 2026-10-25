import type { HarnessV1RequestTransformation } from '@ai-sdk/harness';

import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import type { Logger } from '../../common/logger.js';
import type { SandboxDescription, SandboxNetwork } from '../../protocol/api.js';
import type { ComputeApi, Instance } from '../compute/compute-api.js';
import type { AgentEndpoint } from './agent-client.js';
import type { ProxyAdmin } from './proxy-admin.js';

import { HttpError } from '../../common/http-error.js';
import { PACKAGE_VERSION } from '../../common/package-version.js';
import { AGENT_TOKEN_METADATA_KEY } from '../../protocol/agent.js';
import { PROTOCOL_VERSION } from '../../protocol/version.js';
import { ComputeError } from '../compute/compute-error.js';
import { AgentClient, agentToken } from './agent-client.js';

/** What every sandbox's machine is made of: the service's to give. */
export interface MachineSettings {
  /** `e2-standard-4`, or a custom type: `e2-custom-4-8192`. */
  machineType: string;
  /**
   * The image the machines boot from, relative to the API's root:
   * `projects/<project>/global/images/<name>`, or `…/images/family/<family>` for the latest.
   */
  image: string;
  diskSizeGb: number;
  /** `pd-balanced`, `pd-ssd`… */
  diskType: string;
  /** The VPC network and subnetwork of the machines; the project's default network without them. */
  network?: string;
  subnetwork?: string;
  /** Network tags: what the VPC firewall rules of the sandboxes apply to. */
  tags: readonly string[];
  /** Spot machines, stopped (not deleted) when Compute Engine takes them back. */
  spot: boolean;
}

/** How the sandboxes are made: the service's to give. */
export interface SandboxesOptions {
  compute: ComputeApi;
  proxy: ProxyAdmin;
  logger: Logger;
  zone: string;
  machine: MachineSettings;
  /** Put before a sandbox's name to make its instance's: `sbx-`. */
  instancePrefix: string;
  /** What the agents' tokens are derived from. */
  agentSecret: string;
  /** The port the agents listen on. */
  agentPort: number;
  /** Where the agent of a machine is reached: its internal address by default. Tests only. */
  agentAddress?: (instance: Instance) => { host: string; port: number };
  /** The egress proxy, as the machines reach it: `http://10.0.0.2:3128`. */
  proxyUrl: string;
  /** What every sandbox may reach, before what the caller adds. */
  network: Required<SandboxNetwork>;
  /** How long a machine has to boot and its agent to answer. */
  startTimeoutMs: number;
}

/** The label of the service's machines and images, and what each is. */
const LABEL = 'ai-sdk-sandbox';

/** A name of a sandbox or a template: what an instance or image name and a URL path all take. */
const NAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/** Statuses a machine moves on from by itself. */
const TRANSIENT = new Set(['PROVISIONING', 'REPAIRING', 'STAGING', 'STOPPING', 'SUSPENDING']);

/** How long the address of a running machine is trusted before it is read again. */
const ADDRESS_KEPT_MS = 5000;

/** How long a resolved base image is trusted: a family moves on when a new image is built. */
const IMAGE_KEPT_MS = 5 * 60_000;

/** Compute Engine's names are 63 characters at most. */
const MAX_NAME = 63;

function assertName(name: string, what: string, room: number): void {
  if (!NAME.test(name) || name.length > room) {
    throw new HttpError(
      400,
      `Invalid ${what} name "${name}": lowercase letters, digits and dashes, starting and ending with a letter or a digit, ${room} at most.`,
    );
  }
}

/**
 * The sandboxes, each a Compute Engine machine of its own, named after it. The service keeps nothing
 * of them: what a machine is, Compute Engine says; what it may reach and its credentials, the egress
 * proxy holds; its processes, its agent runs. Any instance of the service, on any Cloud Run instance,
 * serves any sandbox.
 */
export class Sandboxes {
  private readonly endpoints = new Map<string, { endpoint: AgentEndpoint; until: number }>();
  private base?: { namespace: string; until: number };

  constructor(private readonly options: SandboxesOptions) {
    if (!/^[a-z][a-z0-9-]{0,7}$/.test(options.instancePrefix)) {
      throw new Error(
        `The instance prefix "${options.instancePrefix}" must start with a letter and hold 8 lowercase letters, digits or dashes at most.`,
      );
    }
  }

  /** The agent of the running sandbox `name`. */
  async agent(name: string): Promise<AgentClient> {
    this.assertSandboxName(name);
    const cached = this.endpoints.get(name);
    if (cached !== undefined && Date.now() < cached.until) return new AgentClient(cached.endpoint);
    const instance = await this.instanceOf(name);
    if (instance?.status !== 'RUNNING') {
      throw new HttpError(404, `No sandbox "${name}" is running.`);
    }
    return new AgentClient(this.remember(name, instance));
  }

  /** Creates the sandbox `name`, from the template `template` when given. Never resumes one. */
  async create(
    name: string,
    { template, ...network }: SandboxNetwork & { template?: string },
  ): Promise<SandboxDescription> {
    this.assertSandboxName(name);
    const instance = this.instanceName(name);
    if ((await this.options.compute.getInstance(instance)) !== undefined) {
      throw new HttpError(409, `A sandbox named "${name}" already exists.`);
    }
    const sourceImage =
      template === undefined ? this.options.machine.image : await this.templateImage(template);
    const startedAt = Date.now();
    try {
      await this.options.compute.insertInstance(this.instanceBody(instance, sourceImage));
    } catch (error) {
      if (error instanceof ComputeError && error.status === 409) {
        throw new HttpError(409, `A sandbox named "${name}" already exists.`);
      }
      throw error;
    }
    try {
      const description = await this.ready(name, network);
      this.options.logger.info(`${name} created in ${Date.now() - startedAt} ms`);
      return description;
    } catch (error) {
      // Half-made, the machine would block a retry under the same name, and cost.
      await this.delete(name).catch(() => undefined);
      throw error;
    }
  }

  /**
   * The sandbox `name`, running, or its machine started again on its disk, the processes it ran
   * gone. Never creates one.
   */
  async resume(name: string, network: SandboxNetwork): Promise<SandboxDescription> {
    this.assertSandboxName(name);
    const instance = this.instanceName(name);
    const deadline = Date.now() + this.options.startTimeoutMs;
    const startedAt = Date.now();
    for (;;) {
      const current = await this.instanceOf(name);
      if (current === undefined) {
        throw new HttpError(404, `No sandbox "${name}": it was never created, or it was deleted.`);
      }
      if (current.status === 'RUNNING') break;
      if (current.status === 'TERMINATED') {
        await this.options.compute.startInstance(instance);
      } else if (current.status === 'SUSPENDED') {
        await this.options.compute.resumeInstance(instance);
      } else if (TRANSIENT.has(current.status) && Date.now() < deadline) {
        await sleep(2000);
      } else {
        throw new HttpError(503, `The machine of "${name}" is ${current.status}: try again later.`);
      }
    }
    const description = await this.ready(name, network);
    this.options.logger.info(`${name} resumed in ${Date.now() - startedAt} ms`);
    return description;
  }

  /**
   * Stops the sandbox's machine, its disk kept: the proxy forgets its credentials first. Nothing
   * runs, nothing is billed but the disk, until a resume. Idempotent.
   */
  async suspend(name: string): Promise<void> {
    this.assertSandboxName(name);
    const instance = await this.instanceOf(name);
    if (instance === undefined) return;
    await this.forget(name);
    if (instance.status !== 'TERMINATED') {
      await this.options.compute.stopInstance(instance.name);
      this.options.logger.info(`${name} suspended`);
    }
  }

  /** Deletes the sandbox's machine and its disk. Idempotent. */
  async delete(name: string): Promise<void> {
    this.assertSandboxName(name);
    await this.forget(name);
    await this.options.compute.deleteInstance(this.instanceName(name));
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
   * Saves the disk of the sandbox `name` as the template `id`, which new sandboxes boot from. The
   * machine is stopped first, for a disk at rest: the caller deletes it once the image is made.
   */
  async saveTemplate(name: string, id: string): Promise<void> {
    this.assertSandboxName(name);
    const image = await this.templateImageName(id);
    const instance = await this.instanceOf(name);
    if (instance === undefined) throw new HttpError(404, `No sandbox "${name}".`);
    await this.forget(name);
    await this.options.compute.stopInstance(instance.name);
    try {
      await this.options.compute.insertImage(image, instance.name, {
        [LABEL]: 'template',
        [`${LABEL}-base`]: await this.namespace(),
      });
    } catch (error) {
      // Another process saved the same template meanwhile: it is as good.
      if (!(error instanceof ComputeError && error.status === 409)) throw error;
    }
    this.options.logger.info(`${name} saved as the template ${id}`);
  }

  async templateExists(id: string): Promise<boolean> {
    const image = await this.options.compute.getImage(
      this.options.compute.imagePath(await this.templateImageName(id)),
    );
    return image !== undefined && (image.status === undefined || image.status === 'READY');
  }

  async deleteTemplate(id: string): Promise<void> {
    await this.options.compute.deleteImage(await this.templateImageName(id));
  }

  /** The instance of the sandbox `name`: `undefined` when there is none, or one not the service's. */
  private async instanceOf(name: string): Promise<Instance | undefined> {
    const instance = await this.options.compute.getInstance(this.instanceName(name));
    return instance?.labels?.[LABEL] === 'sandbox' ? instance : undefined;
  }

  /**
   * Makes the running machine of `name` ready for commands: registered with the egress proxy
   * under its address, its agent answering and configured.
   */
  private async ready(name: string, network: SandboxNetwork): Promise<SandboxDescription> {
    const instance = await this.instanceOf(name);
    const address = instance?.networkInterfaces?.[0]?.networkIP;
    if (instance?.status !== 'RUNNING' || address === undefined) {
      throw new HttpError(503, `The machine of "${name}" did not start.`);
    }
    const endpoint = this.remember(name, instance);
    const baseUrls = { ...this.options.network.baseUrls, ...network.baseUrls };
    await this.options.proxy.register(name, {
      address,
      allowedHosts: this.allowedHosts(network.allowedHosts ?? []),
      baseUrls,
    });
    const agent = new AgentClient(endpoint);
    await this.waitForAgent(name, agent);
    const { home, workingDirectory } = await agent.configure({
      proxy: this.options.proxyUrl,
      baseUrls,
    });
    return { name, home, workingDirectory };
  }

  private async waitForAgent(name: string, agent: AgentClient): Promise<void> {
    const deadline = Date.now() + this.options.startTimeoutMs;
    for (;;) {
      const protocol = await agent.health();
      if (protocol === PROTOCOL_VERSION) return;
      if (protocol !== undefined) {
        throw new HttpError(
          502,
          `The agent of "${name}" speaks protocol ${protocol} of ai-sdk-sandbox-gce, this service ${PROTOCOL_VERSION} (version ${PACKAGE_VERSION}): build the sandbox image with the version of the package the service runs.`,
        );
      }
      if (Date.now() > deadline) {
        throw new HttpError(
          504,
          `The agent of "${name}" did not answer within ${this.options.startTimeoutMs / 1000} s: check that the image runs \`ai-sdk-sandbox-gce agent\` and that the firewall lets the service reach port ${this.options.agentPort}.`,
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

  private remember(name: string, instance: Instance): AgentEndpoint {
    const { host, port } = this.options.agentAddress?.(instance) ?? {
      host: instance.networkInterfaces?.[0]?.networkIP ?? '',
      port: this.options.agentPort,
    };
    const endpoint = { host, port, token: agentToken(this.options.agentSecret, instance.name) };
    this.endpoints.set(name, { endpoint, until: Date.now() + ADDRESS_KEPT_MS });
    return endpoint;
  }

  private allowedHosts(extra: readonly string[]): string[] {
    return [...new Set([...this.options.network.allowedHosts, ...extra])];
  }

  private instanceName(name: string): string {
    return `${this.options.instancePrefix}${name}`;
  }

  private assertSandboxName(name: string): void {
    assertName(name, 'sandbox', MAX_NAME - this.options.instancePrefix.length);
  }

  /** The image a template boots from: its id, then what the templates are made on. */
  private async templateImageName(id: string): Promise<string> {
    assertName(id, 'template', MAX_NAME - 9);
    return `${id}-${await this.namespace()}`;
  }

  private async templateImage(id: string): Promise<string> {
    if (!(await this.templateExists(id))) throw new HttpError(404, `No template "${id}".`);
    return this.options.compute.imagePath(await this.templateImageName(id));
  }

  /**
   * What the templates are made on: this package and the base image, a family resolved to its
   * latest image. A template is only ever used on the image it was made on: after a new base image,
   * the first sandbox makes the template again.
   */
  private async namespace(): Promise<string> {
    if (this.base !== undefined && Date.now() < this.base.until) return this.base.namespace;
    const image = await this.options.compute.getImage(this.options.machine.image);
    if (image === undefined) {
      throw new HttpError(500, `The base image ${this.options.machine.image} does not exist.`);
    }
    const namespace = createHash('sha256')
      .update(JSON.stringify([PACKAGE_VERSION, image.selfLink]))
      .digest('hex')
      .slice(0, 8);
    this.base = { namespace, until: Date.now() + IMAGE_KEPT_MS };
    return namespace;
  }

  private instanceBody(name: string, sourceImage: string): Record<string, unknown> {
    const { machine, zone } = this.options;
    return {
      name,
      machineType: `zones/${zone}/machineTypes/${machine.machineType}`,
      labels: { [LABEL]: 'sandbox' },
      tags: { items: machine.tags },
      disks: [
        {
          boot: true,
          autoDelete: true,
          initializeParams: {
            diskName: name,
            sourceImage,
            diskSizeGb: String(machine.diskSizeGb),
            diskType: `zones/${zone}/diskTypes/${machine.diskType}`,
            labels: { [LABEL]: 'sandbox' },
          },
        },
      ],
      // No access config: no external address. The machine only reaches the egress proxy.
      networkInterfaces: [
        {
          ...(machine.network === undefined ? {} : { network: machine.network }),
          ...(machine.subnetwork === undefined ? {} : { subnetwork: machine.subnetwork }),
        },
      ],
      metadata: {
        items: [
          { key: AGENT_TOKEN_METADATA_KEY, value: agentToken(this.options.agentSecret, name) },
          { key: 'block-project-ssh-keys', value: 'true' },
          { key: 'serial-port-enable', value: 'false' },
        ],
      },
      // No service account: nothing in the machine holds a Google credential.
      serviceAccounts: [],
      shieldedInstanceConfig: {
        enableSecureBoot: true,
        enableVtpm: true,
        enableIntegrityMonitoring: true,
      },
      scheduling: machine.spot
        ? {
            provisioningModel: 'SPOT',
            instanceTerminationAction: 'STOP',
            automaticRestart: false,
            onHostMaintenance: 'TERMINATE',
          }
        : { automaticRestart: true, onHostMaintenance: 'MIGRATE' },
    };
  }
}
