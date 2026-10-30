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
  /**
   * How many machines are kept booted from the template of the last creation from one, for the
   * next such creations to take at once rather than boot one: billed while they run, all the time.
   * Created in the request of a creation, never waited for. None without it.
   */
  warmPool?: number;
  /**
   * Never stops the proxy's machine of {@link proxyInstance} once no sandbox runs: a sandbox never
   * waits for it to boot, and it is billed all the time. Stopped when idle without it.
   */
  proxyAlwaysOn?: boolean;
}

/** The label of the service's machines and images, and what each is. */
const LABEL = 'ai-sdk-sandbox';

/** The label naming the image a machine or a template was made on. */
const IMAGE_LABEL = 'ai-sdk-sandbox-image';

/**
 * The label naming the sandbox a machine holds when its instance is not named after it: a machine
 * of the warm pool, which Compute Engine cannot rename once taken.
 */
const NAME_LABEL = 'ai-sdk-sandbox-name';

/** The label of a machine of the warm pool naming the template image it booted from. */
const POOL_TEMPLATE_LABEL = 'ai-sdk-sandbox-template';

/** The label of a machine of the warm pool on its way out: no creation takes it any more. */
const RETIRED_LABEL = 'ai-sdk-sandbox-retired';

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

/**
 * How long the instance found holding a sandbox is remembered, checked at each use: the machine of
 * a sandbox taken from the warm pool is only found by its label otherwise.
 */
const MACHINE_KEPT_MS = 10 * 60_000;

/** How long a resolved base image is trusted: a family moves on when a new image is built. */
const IMAGE_KEPT_MS = 5 * 60_000;

/** The image a sandbox gets when its caller names none. */
export const DEFAULT_IMAGE = 'default';

/** The instance metadata key of the run the agent's token was drawn for, see {@link agentToken}. */
const AGENT_RUN_METADATA_KEY = 'ai-sdk-sandbox-agent-run';

/** The run the machine's agent token was drawn for: none on a machine made before runs were. */
const runOf = (instance: Instance): string | undefined =>
  instance.metadata?.items?.find(({ key }) => key === AGENT_RUN_METADATA_KEY)?.value;

/** When the machine `instance` last started, in milliseconds: now when Compute Engine does not say. */
function startedAt(instance: Instance): number {
  const started = Date.parse(instance.lastStartTimestamp ?? instance.creationTimestamp ?? '');
  return Number.isNaN(started) ? Date.now() : started;
}

/** Why a creation is refused: the name is taken. */
const alreadyExists = (name: string): HttpError =>
  new HttpError(409, `A sandbox named "${name}" already exists.`);

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
 * The sandboxes, each a Compute Engine machine of its own, named after it, or labelled with its
 * name when taken from the warm pool. The service keeps nothing of them: what a machine is, Compute
 * Engine says; what it may reach and its credentials, the egress proxy holds; its processes, its
 * agent runs. Any instance of the service, on any Cloud Run instance, serves any sandbox.
 */
export class Sandboxes {
  private readonly endpoints = new Map<string, { endpoint: AgentEndpoint; until: number }>();
  private readonly machines = new Map<string, { instance: string; until: number }>();
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
   * Creates the sandbox `name` on the image `image`, from its template `template` when given: on a
   * machine of the warm pool booted from it when one runs, a new machine otherwise. Never resumes
   * one.
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
    if (!(await this.nameIsFree(name))) throw alreadyExists(name);
    const sourceImage = template === undefined ? base : await this.templateImage(template, image);
    await this.assertRoom();
    const startedAt = Date.now();
    // The proxy boots meanwhile, when it was stopped: ready() waits for it.
    const proxyUp = this.proxyUp();
    proxyUp.catch(() => undefined);
    const source = { sourceImage, image };
    const pool = template === undefined ? undefined : await this.fromPool(name, source);
    try {
      const taken = pool?.taken;
      const description = await this.settle(
        name,
        network,
        taken ?? (await this.insertSandbox(name, source)),
      );
      const from = taken === undefined ? '' : ` on ${taken.name} of the warm pool`;
      this.options.logger.info(`${name} created in ${Date.now() - startedAt} ms${from}`);
      return description;
    } finally {
      // Before answering: Cloud Run throttles the instance's CPU once it has answered.
      await pool?.upkeep;
    }
  }

  /**
   * The sandbox `name`, running, or its machine started again on its disk, the processes it ran
   * gone. Never creates one.
   */
  async resume(name: string, network: SandboxNetwork): Promise<SandboxDescription> {
    this.assertSandboxName(name);
    const deadline = Date.now() + this.options.startTimeoutMs;
    const startedAt = Date.now();
    let current: Instance | undefined;
    for (;;) {
      current = await this.instanceOf(name);
      if (current === undefined) {
        throw new HttpError(404, `No sandbox "${name}": it was never created, or it was deleted.`);
      }
      if (current.status === 'RUNNING') break;
      if (current.status === 'TERMINATED') {
        await this.assertRoom();
        await Promise.all([this.start(current.name), this.proxyUp()]);
      } else if (current.status === 'SUSPENDED') {
        await this.assertRoom();
        await Promise.all([this.options.compute.resumeInstance(current.name), this.proxyUp()]);
      } else if (TRANSIENT.has(current.status) && Date.now() < deadline) {
        await sleep(2000);
      } else {
        throw new HttpError(503, `The machine of "${name}" is ${current.status}: try again later.`);
      }
    }
    const description = await this.ready(name, network, current);
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
    await this.removeMachine(name, (await this.instanceOf(name))?.name);
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
        .map((machine) => [machine.networkInterfaces?.[0]?.networkIP, machine]),
    );
    const stale = registered.filter(({ name, address }) => {
      const holder = holders.get(address);
      if (holder === undefined) return true;
      return holder.name.startsWith(this.options.instancePrefix) && this.sandboxOf(holder) !== name;
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
   * Starts the proxy's machine when the service drives it and it is stopped, without waiting for it
   * to boot: a sandbox created soon after finds it up, rather than waiting for it. Nothing else:
   * the proxy stops with the next sandbox that stops, or by itself when none comes.
   */
  async prepare(): Promise<void> {
    const { proxyInstance, compute, logger } = this.options;
    if (proxyInstance === undefined) return;
    const current = await compute.getInstance(proxyInstance);
    if (current?.status !== 'TERMINATED') return;
    logger.info(`Preparing: starting the egress proxy ${proxyInstance}`);
    await compute.startInstance(proxyInstance, { wait: false });
  }

  /**
   * Takes for the sandbox `name` a running machine of the warm pool booted from `sourceImage`, and
   * sees to the pool: its machines of another template, or no longer running (a Spot machine taken
   * back, one at its run limit), deleted, and those missing created. `upkeep` does so without
   * waiting for Compute Engine, never failing: the caller awaits it before answering. A machine of
   * the pool never ran an agent, as fresh as one made from the template; once taken, it never goes
   * back to the pool.
   */
  private async fromPool(
    name: string,
    template: { image: string; sourceImage: string },
  ): Promise<{ taken?: Instance; upkeep: Promise<void> }> {
    const { compute, logger, warmPool = 0 } = this.options;
    const templateLabel = template.sourceImage.split('/').at(-1) ?? '';
    const machines = (await compute.listInstances(LABEL, 'pool'))
      .filter(
        ({ name: instance, labels }) =>
          labels?.[LABEL] === 'pool' && instance.startsWith(this.poolPrefix),
      )
      .sort((a, b) => startedAt(a) - startedAt(b));
    const fit = (machine: Instance): boolean =>
      machine.labels?.[POOL_TEMPLATE_LABEL] === templateLabel &&
      machine.labels[RETIRED_LABEL] === undefined &&
      RUNNING.has(machine.status) &&
      this.youngEnough(machine);
    const kept = machines.filter(fit);
    const dropped = machines.filter((machine) => !fit(machine));
    let taken: Instance | undefined;
    const tried = new Set<string>();
    try {
      // The oldest first: its agent is the likeliest to answer already.
      for (const machine of kept.filter(({ status }) => status === 'RUNNING')) {
        tried.add(machine.name);
        taken = await this.take(machine, name);
        if (taken !== undefined) break;
      }
    } catch (error) {
      // Left alone rather than grown: a pool whose machines cannot be taken would only cost.
      logger.warn(`The warm pool is left alone: ${String(error)}`);
      return { upkeep: Promise.resolve() };
    }
    const left = kept.filter((machine) => !tried.has(machine.name));
    dropped.push(...left.slice(warmPool));
    const missing = Math.max(0, warmPool - left.length);
    const changes = [
      ...dropped.map((machine) => this.retire(machine)),
      ...Array.from({ length: missing }, () => this.addToPool(template, templateLabel)),
    ];
    const upkeep = Promise.allSettled(changes).then((results) => {
      for (const result of results) {
        if (result.status === 'rejected') {
          logger.warn(`The warm pool could not be kept: ${String(result.reason)}`);
        }
      }
    });
    return { taken, upkeep };
  }

  /**
   * Takes the machine `machine` of the warm pool for the sandbox `name`, by its labels: of two
   * creations taking it at once, Compute Engine lets one change them only. The machine as it is
   * then, `undefined` when another creation took it, or it no longer runs. Fails when Compute
   * Engine refuses the change for another reason.
   */
  private async take(machine: Instance, name: string): Promise<Instance | undefined> {
    const { compute, logger } = this.options;
    try {
      await compute.setLabels(
        machine.name,
        { ...machine.labels, [LABEL]: 'sandbox', [NAME_LABEL]: name },
        machine.labelFingerprint,
      );
    } catch (error) {
      if (error instanceof ComputeError && (error.status === 412 || error.status === 404)) {
        return undefined;
      }
      throw error;
    }
    const taken = await compute.getInstance(machine.name);
    if (taken === undefined || !this.holds(taken, name)) return undefined;
    if (taken.status !== 'RUNNING') {
      // Stopped meanwhile, and the sandbox's now: deleted rather than left to block its name.
      await compute.deleteInstance(taken.name, { wait: false });
      return undefined;
    }
    logger.info(`${name} takes ${taken.name} from the warm pool`);
    return taken;
  }

  /**
   * Deletes the machine `machine` of the warm pool, once labelled retired: a creation that read it
   * before can no longer take it, nor this one take it from under a creation that did.
   */
  private async retire(machine: Instance): Promise<void> {
    const { compute, logger } = this.options;
    if (machine.labels?.[RETIRED_LABEL] === undefined) {
      try {
        await compute.setLabels(
          machine.name,
          { ...machine.labels, [RETIRED_LABEL]: 'true' },
          machine.labelFingerprint,
        );
      } catch (error) {
        if (error instanceof ComputeError && (error.status === 412 || error.status === 404)) return;
        throw error;
      }
    }
    logger.info(`Deleting ${machine.name} of the warm pool (${machine.status})`);
    await compute.deleteInstance(machine.name, { wait: false });
  }

  /** Creates a machine of the warm pool booted from `template`, without waiting for it. */
  private async addToPool(
    template: { image: string; sourceImage: string },
    templateLabel: string,
  ): Promise<void> {
    const instance = `${this.poolPrefix}${randomBytes(4).toString('hex')}`;
    this.options.logger.info(`Creating ${instance} for the warm pool, from ${templateLabel}`);
    const labels = {
      [LABEL]: 'pool',
      [IMAGE_LABEL]: template.image,
      [POOL_TEMPLATE_LABEL]: templateLabel,
    };
    await this.insert(instance, { ...template, labels }, { wait: false });
  }

  /**
   * Whether the machine `machine` of the warm pool has half its run limit left at least, so that the
   * sandbox taking it is not stopped soon after: Compute Engine counts it from the machine's start.
   */
  private youngEnough(machine: Instance): boolean {
    const { maxRunSeconds } = this.options.machine;
    return maxRunSeconds === undefined || Date.now() - startedAt(machine) < maxRunSeconds * 500;
  }

  /** What the machines of the warm pool are named after: the service's prefix, then `pool-`. */
  private get poolPrefix(): string {
    return `${this.options.instancePrefix}pool-`;
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

  /**
   * Stops the proxy's machine, when the service drives it and does not keep it running, once no
   * sandbox runs: the machines of the warm pool are none, and need no proxy until taken.
   */
  private async proxyDownWhenIdle(): Promise<void> {
    const { proxyInstance, proxyAlwaysOn, compute } = this.options;
    if (proxyInstance === undefined || proxyAlwaysOn === true) return;
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
   * Whether no instance is named after the sandbox `name`, nor holds it under its label, once those
   * going away are gone: a machine stopping may be on its way to deletion, which takes some 50 s
   * after the sandbox's own.
   */
  private async nameIsFree(name: string): Promise<boolean> {
    const { compute, startTimeoutMs } = this.options;
    const deadline = Date.now() + startTimeoutMs;
    for (;;) {
      const named = await compute.getInstance(this.instanceName(name));
      const holders = named === undefined ? await this.labelled(name) : [named];
      if (holders.length === 0) return true;
      if (holders.some(({ status }) => status !== 'STOPPING') || Date.now() > deadline) {
        return false;
      }
      await sleep(2000);
    }
  }

  /** Creates the machine named after the sandbox `name`, and answers its name. */
  private async insertSandbox(
    name: string,
    source: { image: string; sourceImage: string },
  ): Promise<string> {
    const instance = this.instanceName(name);
    try {
      await this.insert(instance, source);
    } catch (error) {
      if (error instanceof ComputeError && error.status === 409) throw alreadyExists(name);
      throw error;
    }
    return instance;
  }

  /**
   * Makes the new machine `made` the sandbox `name`'s, and ready: taken from the warm pool as it
   * is, or created under its name and read. Deleted when another machine holds the name too, or
   * anything fails: half-made, it would block a retry under the same name, and cost.
   */
  private async settle(
    name: string,
    network: SandboxNetwork,
    made: Instance | string,
  ): Promise<SandboxDescription> {
    const machine = typeof made === 'string' ? made : made.name;
    if (!(await this.soleHolder(name, machine))) {
      // Another creation of the same name took a machine meanwhile: the name is its.
      await this.options.compute.deleteInstance(machine, { wait: false });
      throw alreadyExists(name);
    }
    try {
      const instance =
        typeof made === 'string' ? await this.options.compute.getInstance(made) : made;
      return await this.ready(name, network, instance);
    } catch (error) {
      await this.removeMachine(name, machine).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Whether the machine `instance` is the only one holding the sandbox `name`: two creations of the
   * same name, one on a machine of the warm pool, are not stopped by Compute Engine as two machines
   * of the same name are. The one that finds the other's loses; both may.
   */
  private async soleHolder(name: string, instance: string): Promise<boolean> {
    const named = this.instanceName(name);
    const [direct, labelled] = await Promise.all([
      named === instance ? undefined : this.options.compute.getInstance(named),
      this.labelled(name),
    ]);
    const holders = [
      ...(direct !== undefined && this.holds(direct, name) ? [direct] : []),
      ...labelled,
    ];
    return holders.every((holder) => holder.name === instance);
  }

  /** The machines holding the sandbox `name` under its label: taken from the warm pool. */
  private async labelled(name: string): Promise<Instance[]> {
    const found = await this.options.compute.listInstances(NAME_LABEL, name);
    return found.filter(
      ({ labels }) => labels?.[LABEL] === 'sandbox' && labels[NAME_LABEL] === name,
    );
  }

  /**
   * Creates the machine `instance`, a standard one when the zone has no Spot capacity left: of the
   * sandbox it is named after, or of the warm pool with its `labels`. Not waited for with `wait`
   * false: a missing capacity then goes unseen, and the machine is not made.
   */
  private async insert(
    instance: string,
    source: { image: string; sourceImage: string; labels?: Record<string, string> },
    { wait = true }: { wait?: boolean } = {},
  ): Promise<void> {
    const { compute, logger, zone } = this.options;
    try {
      await compute.insertInstance(this.instanceBody(instance, source), { wait });
    } catch (error) {
      if (!this.mayFallBack(error)) throw error;
      logger.warn(`No Spot capacity in ${zone}: ${instance} is created as a standard machine.`);
      await compute.insertInstance(this.instanceBody(instance, { ...source, standard: true }), {
        wait,
      });
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

  /**
   * The instance of the sandbox `name`: `undefined` when there is none, or one not the service's.
   * The one named after it, or else the one holding it under its label, taken from the warm pool;
   * the one found last tried first.
   */
  private async instanceOf(name: string): Promise<Instance | undefined> {
    const { compute } = this.options;
    const named = this.instanceName(name);
    const cached = this.machines.get(name);
    if (cached !== undefined && Date.now() < cached.until && cached.instance !== named) {
      const instance = await compute.getInstance(cached.instance);
      if (instance !== undefined && this.holds(instance, name)) return instance;
    }
    const instance = await compute.getInstance(named);
    if (instance !== undefined && this.holds(instance, name)) return instance;
    const [labelled] = await this.labelled(name);
    if (labelled !== undefined) {
      this.machines.set(name, { instance: labelled.name, until: Date.now() + MACHINE_KEPT_MS });
    }
    return labelled;
  }

  /** The sandbox the machine `instance` holds: its label's, or the one it is named after. */
  private sandboxOf(instance: Instance): string | undefined {
    const labelled = instance.labels?.[NAME_LABEL];
    if (labelled !== undefined) return labelled;
    const { instancePrefix } = this.options;
    return instance.name.startsWith(instancePrefix)
      ? instance.name.slice(instancePrefix.length)
      : undefined;
  }

  /** Whether `instance` is a sandbox's machine of the service, holding `name`. */
  private holds(instance: Instance, name: string): boolean {
    return instance.labels?.[LABEL] === 'sandbox' && this.sandboxOf(instance) === name;
  }

  /**
   * Deletes the machine `instance` of the sandbox `name`, the proxy made to forget it first, and
   * returns once it left `RUNNING`. Only the proxy's registration without `instance`.
   */
  private async removeMachine(name: string, instance: string | undefined): Promise<void> {
    this.machines.delete(name);
    await this.forget(name);
    if (instance !== undefined) {
      await this.options.compute.deleteInstance(instance, { wait: false });
      await this.leftRunning(instance);
      this.options.logger.info(`${name} deleting`);
    }
    await this.proxyDownWhenIdle();
  }

  /**
   * Makes the running machine `instance` of `name` ready for commands: registered with the egress
   * proxy under its address, its agent answering and configured.
   */
  private async ready(
    name: string,
    network: SandboxNetwork,
    instance: Instance | undefined,
  ): Promise<SandboxDescription> {
    const address = instance?.networkInterfaces?.[0]?.networkIP;
    if (
      instance === undefined ||
      !this.holds(instance, name) ||
      instance.status !== 'RUNNING' ||
      address === undefined
    ) {
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
    if (instance.name !== this.instanceName(name)) {
      this.machines.set(name, { instance: instance.name, until: Date.now() + MACHINE_KEPT_MS });
    }
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
      labels = { [LABEL]: 'sandbox', [IMAGE_LABEL]: image },
      standard = false,
    }: { image: string; sourceImage: string; labels?: Record<string, string>; standard?: boolean },
  ): Record<string, unknown> {
    const { machine, zone } = this.options;
    return {
      name,
      machineType: `zones/${zone}/machineTypes/${machine.machineType}`,
      labels,
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
