import type { HarnessV1RequestTransformation } from '@ai-sdk/harness';

import { createHash, randomBytes } from 'node:crypto';
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
   * The images the machines boot from, by the name callers pick them with, `default` the one they
   * get without: one per toolchain, say. Each relative to the API's root:
   * `projects/<project>/global/images/<name>`, or `…/images/family/<family>` for the latest.
   */
  images: Readonly<Record<string, string>>;
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
  /**
   * When the zone has no Spot capacity left, create or start the machine as a standard one rather
   * than fail: it stays standard, billed as such, until deleted. On unless `false`.
   */
  spotFallback?: boolean;
  /**
   * The longest a machine runs at a time, in seconds: Compute Engine stops it then, whatever the
   * service or the application do, its disk kept. No limit without it.
   */
  maxRunSeconds?: number;
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
  /**
   * The instance of the egress proxy, in the sandboxes' zone, when the service starts and stops it:
   * started with the first sandbox that runs, stopped once none does. Always on without it.
   */
  proxyInstance?: string;
  /**
   * The most sandboxes running at once: a creation or a resume beyond it is refused with a 429.
   * Counted from Compute Engine at each call, so two calls at the same instant may both pass.
   * No limit without it.
   */
  maxRunning?: number;
  /**
   * How often, at most, the service makes the proxy forget the sandboxes whose machine no longer
   * runs, see {@link Sandboxes.reconcile}: in the background of a creation or a resume, the first
   * one at once. Never without it.
   */
  reconcileEveryMs?: number;
}

/** The label of the service's machines and images, and what each is. */
const LABEL = 'ai-sdk-sandbox';

/** The label naming the image a machine or a template was made on. */
const IMAGE_LABEL = 'ai-sdk-sandbox-image';

/** A name of a sandbox or a template: what an instance or image name and a URL path all take. */
const NAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/** Statuses of a machine that runs, or is about to: what {@link SandboxesOptions.maxRunning} counts. */
const RUNNING = new Set(['PROVISIONING', 'REPAIRING', 'RUNNING', 'STAGING']);

/** Statuses of a machine whose guest is off, or on its way: its agent will read its token anew. */
const STOPPED = new Set(['STOPPING', 'TERMINATED']);

/** Statuses a machine moves on from by itself. */
const TRANSIENT = new Set(['PROVISIONING', 'REPAIRING', 'STAGING', 'STOPPING', 'SUSPENDING']);

/** How long the address of a running machine is trusted before it is read again. */
const ADDRESS_KEPT_MS = 5000;

/** How a machine runs when it is not Spot. */
const STANDARD_SCHEDULING = { automaticRestart: true, onHostMaintenance: 'MIGRATE' };

/** How long a resolved base image is trusted: a family moves on when a new image is built. */
const IMAGE_KEPT_MS = 5 * 60_000;

/** The image a sandbox gets when its caller names none. */
export const DEFAULT_IMAGE = 'default';

/** The instance metadata key of the run the agent's token was drawn for, see {@link agentToken}. */
const AGENT_RUN_METADATA_KEY = 'ai-sdk-sandbox-agent-run';

/** The run the machine's agent token was drawn for: none on a machine made before runs were. */
const runOf = (instance: Instance): string | undefined =>
  instance.metadata?.items?.find(({ key }) => key === AGENT_RUN_METADATA_KEY)?.value;

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
  private readonly bases = new Map<string, { namespace: string; until: number }>();
  private nextReconcile = 0;

  constructor(private readonly options: SandboxesOptions) {
    if (options.machine.images[DEFAULT_IMAGE] === undefined) {
      throw new Error(`The sandboxes need a "${DEFAULT_IMAGE}" image.`);
    }
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

  /**
   * Creates the sandbox `name` on the image `image`, from its template `template` when given.
   * Never resumes one.
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
    const base = this.imagePathOf(image);
    const instance = this.instanceName(name);
    if (!(await this.nameIsFree(instance))) {
      throw new HttpError(409, `A sandbox named "${name}" already exists.`);
    }
    const sourceImage = template === undefined ? base : await this.templateImage(template, image);
    await this.assertRoom();
    const startedAt = Date.now();
    // The proxy boots meanwhile, when it was stopped: ready() waits for it.
    const proxyUp = this.proxyUp();
    proxyUp.catch(() => undefined);
    try {
      await this.insert(instance, { sourceImage, image });
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
        await this.assertRoom();
        await Promise.all([this.start(instance), this.proxyUp()]);
      } else if (current.status === 'SUSPENDED') {
        await this.assertRoom();
        await Promise.all([this.options.compute.resumeInstance(instance), this.proxyUp()]);
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
   * Stops the sandbox's machine, its disk kept: the proxy forgets its credentials first, and the
   * agent gets a new token for its next run. Nothing runs, nothing is billed but the disk, until a
   * resume. Returns once the machine left `RUNNING`, the guest off within seconds, not when Compute
   * Engine is done some 50 s later: a resume meanwhile waits for it. Idempotent.
   */
  async suspend(name: string): Promise<void> {
    this.assertSandboxName(name);
    const instance = await this.instanceOf(name);
    if (instance === undefined) return;
    await this.forget(name);
    let stopped: Instance | undefined = instance;
    if (instance.status !== 'TERMINATED') {
      await this.options.compute.stopInstance(instance.name, { wait: false });
      stopped = await this.leftRunning(instance.name);
      this.options.logger.info(`${name} stopping`);
    }
    await this.drawRun(stopped);
    await this.proxyDownWhenIdle();
  }

  /**
   * Deletes the sandbox's machine and its disk. Returns once the machine left `RUNNING`, not when
   * Compute Engine is done some 50 s later: a sandbox created meanwhile under the same name waits
   * for it. Idempotent.
   */
  async delete(name: string): Promise<void> {
    this.assertSandboxName(name);
    await this.forget(name);
    const instance = this.instanceName(name);
    await this.options.compute.deleteInstance(instance, { wait: false });
    await this.leftRunning(instance);
    this.options.logger.info(`${name} deleting`);
    await this.proxyDownWhenIdle();
  }

  /**
   * Makes the proxy forget the sandboxes whose machine no longer runs, and their credentials: a
   * machine stopped or deleted outside the service (a Spot machine taken back, one stopped at its
   * run limit or from the console) leaves them in the proxy until then. A sandbox is kept while a
   * running machine of the zone holds its address, unless it is another sandbox of this service:
   * the sandboxes of another service sharing the proxy in the zone are left alone. A sandbox
   * registered again meanwhile is kept too. Answers the names forgotten.
   */
  async reconcile(): Promise<string[]> {
    const { proxy, compute, logger } = this.options;
    const registered = await proxy.list();
    if (registered === undefined) return [];
    const machines = await compute.listInstances(LABEL, 'sandbox');
    const holders = new Map(
      machines
        .filter(({ status }) => RUNNING.has(status))
        .map(({ name, networkInterfaces }) => [networkInterfaces?.[0]?.networkIP, name]),
    );
    const stale = registered.filter(({ name, address }) => {
      const holder = holders.get(address);
      if (holder === undefined) return true;
      return holder !== this.instanceName(name) && holder.startsWith(this.options.instancePrefix);
    });
    await Promise.all(stale.map(({ name, serial }) => proxy.remove(name, serial)));
    const names = stale.map(({ name }) => name);
    if (names.length > 0) {
      const runs =
        names.length === 1 ? 'its machine no longer runs' : 'their machines no longer run';
      logger.info(`The proxy forgot ${names.join(', ')}: ${runs}`);
    }
    return names;
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
    const instance = await this.instanceOf(name);
    if (instance === undefined) throw new HttpError(404, `No sandbox "${name}".`);
    // The template is made on the image the builder booted from.
    const base = instance.labels?.[IMAGE_LABEL] ?? DEFAULT_IMAGE;
    const image = await this.templateImageName(id, base);
    await this.forget(name);
    await this.options.compute.stopInstance(instance.name);
    try {
      await this.options.compute.insertImage(image, instance.name, {
        [LABEL]: 'template',
        [IMAGE_LABEL]: base,
        [`${LABEL}-base`]: await this.namespace(base),
      });
    } catch (error) {
      // Another process saved the same template meanwhile: it is as good.
      if (!(error instanceof ComputeError && error.status === 409)) throw error;
    }
    this.options.logger.info(`${name} saved as the template ${id}`);
  }

  /** Whether the template `id` exists, made on the image `image`. */
  async templateExists(id: string, image = DEFAULT_IMAGE): Promise<boolean> {
    const name = await this.templateImageName(id, image);
    const found = await this.options.compute.getImage(this.options.compute.imagePath(name));
    return found !== undefined && (found.status === undefined || found.status === 'READY');
  }

  async deleteTemplate(id: string, image = DEFAULT_IMAGE): Promise<void> {
    const name = await this.templateImageName(id, image);
    await this.options.compute.deleteImage(name);
  }

  /**
   * Starts the proxy's machine when the service drives it and it is stopped, and waits until the
   * proxy answers. Stopping, it is first let stop: its registrations go with it, and the sandboxes
   * that start register again.
   */
  private async proxyUp(): Promise<void> {
    const { proxyInstance, compute, proxy, startTimeoutMs } = this.options;
    if (proxyInstance === undefined) return;
    const deadline = Date.now() + startTimeoutMs;
    for (;;) {
      const current = await compute.getInstance(proxyInstance);
      if (current === undefined) {
        throw new HttpError(500, `The egress proxy's machine ${proxyInstance} does not exist.`);
      }
      if (current.status === 'RUNNING' && (await proxy.healthy())) return;
      if (Date.now() > deadline) {
        throw new HttpError(
          504,
          `The egress proxy did not answer within ${startTimeoutMs / 1000} s.`,
        );
      }
      if (current.status === 'TERMINATED') {
        this.options.logger.info(`Starting the egress proxy ${proxyInstance}`);
        await compute.startInstance(proxyInstance);
      } else {
        await sleep(1000);
      }
    }
  }

  /** Starts a {@link reconcile} without waiting for it, once per period at most. */
  private reconcileInBackground(): void {
    const { reconcileEveryMs, logger } = this.options;
    if (reconcileEveryMs === undefined || Date.now() < this.nextReconcile) return;
    this.nextReconcile = Date.now() + reconcileEveryMs;
    this.reconcile().catch((error: unknown) => {
      logger.warn(`The proxy could not be reconciled with the machines: ${String(error)}`);
    });
  }

  /** Stops the proxy's machine, when the service drives it, once no sandbox runs. */
  private async proxyDownWhenIdle(): Promise<void> {
    const { proxyInstance, compute } = this.options;
    if (proxyInstance === undefined) return;
    const machines = await compute.listInstances(LABEL, 'sandbox');
    if (machines.some(({ status }) => RUNNING.has(status))) return;
    const current = await compute.getInstance(proxyInstance);
    if (current?.status !== 'RUNNING') return;
    this.options.logger.info(`No sandbox runs: stopping the egress proxy ${proxyInstance}`);
    await compute.stopInstance(proxyInstance, { wait: false });
  }

  /** Refuses one more running sandbox beyond {@link SandboxesOptions.maxRunning}. */
  private async assertRoom(): Promise<void> {
    const { maxRunning } = this.options;
    if (maxRunning === undefined) return;
    const machines = await this.options.compute.listInstances(LABEL, 'sandbox');
    const running = machines.filter(({ status }) => RUNNING.has(status)).length;
    if (running >= maxRunning) {
      throw new HttpError(
        429,
        `${running} ${running === 1 ? 'sandbox runs' : 'sandboxes run'} already, the most this service runs at once (SANDBOX_MAX_RUNNING=${maxRunning}): stop or delete one, or try again later.`,
      );
    }
  }

  /**
   * Draws a new run for the machine `instance`, on its way down or off, and the agent token that
   * goes with it: the agent reads it as the machine boots again, and a token read before no longer
   * opens it. A running agent, or a suspended one, keeps the token it read: theirs is left as it
   * is. A stop racing this one that changed the metadata first has drawn one already. Failing, the
   * machine keeps its token, as it did before runs were drawn: the stop goes on.
   */
  private async drawRun(instance: Instance | undefined): Promise<void> {
    if (instance === undefined || !STOPPED.has(instance.status)) return;
    const items = (instance.metadata?.items ?? []).filter(
      ({ key }) => key !== AGENT_TOKEN_METADATA_KEY && key !== AGENT_RUN_METADATA_KEY,
    );
    try {
      await this.options.compute.setMetadata(instance.name, {
        fingerprint: instance.metadata?.fingerprint,
        items: [...items, ...this.agentItems(instance.name)],
      });
    } catch (error) {
      if (error instanceof ComputeError && error.status === 412) return;
      this.options.logger.warn(`${instance.name} keeps its agent token: ${String(error)}`);
    }
  }

  /** The metadata the agent of the machine `instance` reads its token from, for a new run. */
  private agentItems(instance: string): { key: string; value: string }[] {
    const run = randomBytes(8).toString('hex');
    return [
      { key: AGENT_TOKEN_METADATA_KEY, value: agentToken(this.options.agentSecret, instance, run) },
      { key: AGENT_RUN_METADATA_KEY, value: run },
    ];
  }

  /**
   * Waits until the machine `instance`, told to stop or go, is no longer `RUNNING`: Compute Engine
   * may still say so for a moment, and a resume would then take it for a machine that runs. The
   * machine as it is then, `undefined` once gone.
   */
  private async leftRunning(instance: string): Promise<Instance | undefined> {
    const deadline = Date.now() + this.options.startTimeoutMs;
    for (;;) {
      const current = await this.options.compute.getInstance(instance);
      if (current?.status !== 'RUNNING') return current;
      if (Date.now() > deadline) {
        throw new HttpError(504, `The machine ${instance} did not stop.`);
      }
      await sleep(1000);
    }
  }

  /**
   * Whether no instance is named `instance`, once the one going away is gone: a machine stopping
   * may be on its way to deletion, which takes some 50 s after the sandbox's own.
   */
  private async nameIsFree(instance: string): Promise<boolean> {
    const deadline = Date.now() + this.options.startTimeoutMs;
    for (;;) {
      const current = await this.options.compute.getInstance(instance);
      if (current === undefined) return true;
      if (current.status !== 'STOPPING' || Date.now() > deadline) return false;
      await sleep(2000);
    }
  }

  /** Creates the machine `instance`, a standard one when the zone has no Spot capacity left. */
  private async insert(
    instance: string,
    source: { image: string; sourceImage: string },
  ): Promise<void> {
    try {
      await this.options.compute.insertInstance(this.instanceBody(instance, source));
    } catch (error) {
      if (!this.mayFallBack(error)) throw error;
      this.options.logger.warn(
        `No Spot capacity in ${this.options.zone}: ${instance} is created as a standard machine.`,
      );
      await this.options.compute.insertInstance(
        this.instanceBody(instance, { ...source, standard: true }),
      );
    }
  }

  /** Starts the stopped machine `instance`, as a standard one when the zone has no Spot capacity. */
  private async start(instance: string): Promise<void> {
    try {
      await this.options.compute.startInstance(instance);
    } catch (error) {
      if (!this.mayFallBack(error)) throw error;
      this.options.logger.warn(
        `No Spot capacity in ${this.options.zone}: ${instance} is started as a standard machine.`,
      );
      // Compute Engine refuses the change unless `preemptible` and the termination action go too.
      await this.options.compute.setScheduling(instance, {
        ...STANDARD_SCHEDULING,
        provisioningModel: 'STANDARD',
        preemptible: false,
        instanceTerminationAction: null,
        ...this.runLimit(),
      });
      await this.options.compute.startInstance(instance);
    }
  }

  /** The run limit of the machines, which Compute Engine enforces by stopping them. */
  private runLimit(): Record<string, unknown> {
    const { maxRunSeconds } = this.options.machine;
    return maxRunSeconds === undefined
      ? {}
      : { maxRunDuration: { seconds: String(maxRunSeconds) }, instanceTerminationAction: 'STOP' };
  }

  private mayFallBack(error: unknown): boolean {
    const { spot, spotFallback } = this.options.machine;
    return spot && spotFallback !== false && error instanceof ComputeError && error.outOfCapacity;
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
    // Running already but for a race with the last sandbox stopping: then started again.
    await this.proxyUp();
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
    // The proxy answers by now: a good time to make it forget the machines gone meanwhile.
    this.reconcileInBackground();
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
    const token = agentToken(this.options.agentSecret, instance.name, runOf(instance));
    const endpoint = { host, port, token };
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

  /** The path of the image callers name `image`: refused unless the service offers it. */
  private imagePathOf(image: string): string {
    const path = this.options.machine.images[image];
    if (path === undefined) {
      const offered = Object.keys(this.options.machine.images).join(', ');
      throw new HttpError(400, `No image "${image}" on this service. It offers: ${offered}.`);
    }
    return path;
  }

  /** The image a template boots from: its id, then what the templates are made on. */
  private async templateImageName(id: string, image: string): Promise<string> {
    assertName(id, 'template', MAX_NAME - 9);
    return `${id}-${await this.namespace(image)}`;
  }

  private async templateImage(id: string, image: string): Promise<string> {
    if (!(await this.templateExists(id, image))) {
      throw new HttpError(404, `No template "${id}" on the image "${image}".`);
    }
    return this.options.compute.imagePath(await this.templateImageName(id, image));
  }

  /**
   * What the templates of `image` are made on: this package and the image, a family resolved to its
   * latest image. A template is only ever used on the image it was made on: after a new image, the
   * first sandbox makes the template again.
   */
  private async namespace(image: string): Promise<string> {
    const cached = this.bases.get(image);
    if (cached !== undefined && Date.now() < cached.until) return cached.namespace;
    const path = this.imagePathOf(image);
    const resolved = await this.options.compute.getImage(path);
    if (resolved === undefined) throw new HttpError(500, `The image ${path} does not exist.`);
    const namespace = createHash('sha256')
      .update(JSON.stringify([PACKAGE_VERSION, resolved.selfLink]))
      .digest('hex')
      .slice(0, 8);
    this.bases.set(image, { namespace, until: Date.now() + IMAGE_KEPT_MS });
    return namespace;
  }

  private instanceBody(
    name: string,
    {
      sourceImage,
      image,
      standard = false,
    }: { image: string; sourceImage: string; standard?: boolean },
  ): Record<string, unknown> {
    const { machine, zone } = this.options;
    return {
      name,
      machineType: `zones/${zone}/machineTypes/${machine.machineType}`,
      labels: { [LABEL]: 'sandbox', [IMAGE_LABEL]: image },
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
          ...this.agentItems(name),
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
      scheduling:
        machine.spot && !standard
          ? {
              provisioningModel: 'SPOT',
              instanceTerminationAction: 'STOP',
              automaticRestart: false,
              onHostMaintenance: 'TERMINATE',
              ...this.runLimit(),
            }
          : { ...STANDARD_SCHEDULING, ...this.runLimit() },
    };
  }
}
