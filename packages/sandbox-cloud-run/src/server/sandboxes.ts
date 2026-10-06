import type { LayerTransfer } from './layer-transfer.js';
import type { Logger } from './logger.js';
import type { SandboxCli } from './sandbox-cli.js';
import type { SandboxProcess, SandboxSettings } from './sandbox.js';
import type { SnapshotStore } from './snapshot-store.js';

import { HttpError } from './http-error.js';
import { LayerTransfers } from './layer-transfer.js';
import { Sandbox } from './sandbox.js';
import { snapshotKey, templateKey } from './snapshot-store.js';

/** A sandbox's or a template's name: what the `sandbox` CLI and a URL path both take as they are. */
const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** What a sandbox may reach: the service's defaults, then the caller's. */
export interface SandboxNetwork {
  allowedHosts?: readonly string[];
  baseUrls?: Readonly<Record<string, string>>;
}

/** How the sandboxes are made: the service's to give. */
export interface SandboxesOptions {
  cli: SandboxCli;
  store: SnapshotStore;
  logger: Logger;
  /** The settings of a sandbox: `{sandbox}` in its paths is its name. */
  sandbox: SandboxSettings;
  /** What every sandbox may reach, before what the caller adds. */
  network: Required<SandboxNetwork>;
  /** Where the tars of the snapshots pass on their way in and out: a pipe, or a file. */
  scratch: string;
  /** How they pass: through a named pipe by default, through a file if the CLI refuses pipes. */
  layerTransfer?: LayerTransfer;
  /**
   * What the templates are made on, the image above all: a template is kept under it, and one made
   * on another image is never used.
   */
  templateNamespace: string;
}

export function assertName(name: string, what = 'sandbox'): void {
  if (!NAME.test(name)) {
    throw new HttpError(
      400,
      `Invalid ${what} name "${name}": lowercase letters, digits and dashes, 63 at most.`,
    );
  }
}

/**
 * The sandboxes, by name: those running, in the instance's memory, and those suspended, as
 * snapshots. The instance only runs while it serves requests: a sandbox lives in the instance while
 * its session works, and in its snapshot between.
 */
export class Sandboxes {
  private readonly running = new Map<string, Sandbox>();
  private readonly starting = new Map<string, Promise<Sandbox>>();
  private readonly transfers: LayerTransfers;

  constructor(private readonly options: SandboxesOptions) {
    this.transfers = new LayerTransfers(options, options.layerTransfer);
  }

  /** The running sandbox `name`. */
  get(name: string): Sandbox {
    const sandbox = this.running.get(name);
    if (sandbox === undefined) throw new HttpError(404, `No sandbox "${name}" is running.`);
    return sandbox;
  }

  /** A process of the running sandbox `name`. */
  process(name: string, id: string): SandboxProcess {
    const started = this.get(name).process(id);
    if (started === undefined) throw new HttpError(404, `No process ${id} in "${name}".`);
    return started;
  }

  /** Creates the sandbox `name`, from the template `template` when given. Never resumes one. */
  async create(
    name: string,
    { template, ...network }: SandboxNetwork & { template?: string },
  ): Promise<Sandbox> {
    assertName(name);
    if (template !== undefined) assertName(template, 'template');
    const taken =
      this.running.has(name) ||
      this.starting.has(name) ||
      (await this.options.store.exists(snapshotKey(name)));
    if (taken) throw new HttpError(409, `A sandbox named "${name}" already exists.`);
    const key =
      template === undefined ? undefined : templateKey(this.options.templateNamespace, template);
    if (key !== undefined && !(await this.options.store.exists(key))) {
      throw new HttpError(404, `No template "${template}".`);
    }
    return this.start(name, network, key);
  }

  /**
   * The sandbox `name`, running, or brought back from its snapshot, which is then spent: the
   * sandbox moves on from it, and its next suspension saves anew. Never creates one.
   */
  async resume(name: string, network: SandboxNetwork): Promise<Sandbox> {
    assertName(name);
    const running = this.running.get(name) ?? (await this.starting.get(name));
    if (running !== undefined) {
      this.applyNetwork(running, network);
      await running.startRelay();
      return running;
    }
    const key = snapshotKey(name);
    if (!(await this.options.store.exists(key))) {
      throw new HttpError(404, `No sandbox "${name}": it was never created, or it was deleted.`);
    }
    const sandbox = await this.start(name, network, key);
    await this.options.store.remove(key);
    return sandbox;
  }

  /** Saves the sandbox to its snapshot, then deletes it from the instance. Idempotent. */
  async suspend(name: string): Promise<void> {
    const sandbox = this.running.get(name);
    if (sandbox === undefined) return;
    const startedAt = Date.now();
    this.running.delete(name);
    try {
      await this.save(sandbox, snapshotKey(name));
    } catch (error) {
      // Not saved: the sandbox keeps running, for a later attempt.
      this.running.set(name, sandbox);
      throw error;
    }
    await sandbox.delete();
    this.options.logger.info(`${name} suspended in ${Date.now() - startedAt} ms`);
  }

  /** Deletes the sandbox and its snapshot. Idempotent. */
  async delete(name: string): Promise<void> {
    assertName(name);
    const sandbox = this.running.get(name);
    this.running.delete(name);
    await sandbox?.delete();
    await this.options.store.remove(snapshotKey(name));
    this.options.logger.info(`${name} deleted`);
  }

  /** Replaces the hosts the running sandbox `name` may reach, the service's own aside. */
  setAllowedHosts(name: string, allowedHosts: readonly string[]): void {
    const sandbox = this.get(name);
    this.applyNetwork(sandbox, { allowedHosts, baseUrls: sandbox.baseUrls });
  }

  /** Saves the running sandbox `name` as the template `id`, which new sandboxes can start from. */
  async saveTemplate(name: string, id: string): Promise<void> {
    assertName(id, 'template');
    await this.save(this.get(name), templateKey(this.options.templateNamespace, id));
    this.options.logger.info(`${name} saved as the template ${id}`);
  }

  templateExists(id: string): Promise<boolean> {
    assertName(id, 'template');
    return this.options.store.exists(templateKey(this.options.templateNamespace, id));
  }

  async deleteTemplate(id: string): Promise<void> {
    assertName(id, 'template');
    await this.options.store.remove(templateKey(this.options.templateNamespace, id));
  }

  /** Cloud Run stops the instance some seconds after `SIGTERM`: what runs is saved if there is time. */
  async suspendAll(): Promise<void> {
    await Promise.all(
      [...this.running.keys()].map((name) =>
        this.suspend(name).catch((error: unknown) => {
          const reason = error instanceof Error ? error.message : String(error);
          this.options.logger.error(
            `${name} could not be saved before the instance stopped: ${reason}`,
          );
        }),
      ),
    );
  }

  /** Starts the sandbox `name`, from the tar under `key` when given. */
  private start(name: string, network: SandboxNetwork, key?: string): Promise<Sandbox> {
    const starting = this.startSandbox(name, network, key).finally(() =>
      this.starting.delete(name),
    );
    this.starting.set(name, starting);
    return starting;
  }

  private async startSandbox(
    name: string,
    network: SandboxNetwork,
    key?: string,
  ): Promise<Sandbox> {
    const startedAt = Date.now();
    const { sandbox: settings, cli } = this.options;
    const named = (path: string): string => path.replaceAll('{sandbox}', name);
    const sandbox = new Sandbox(
      name,
      {
        ...settings,
        home: named(settings.home),
        workingDirectory: named(settings.workingDirectory),
      },
      cli,
    );
    this.applyNetwork(sandbox, network);
    try {
      if (key === undefined) await sandbox.create();
      else if (!(await this.transfers.restore(key, (layer) => this.createFrom(sandbox, layer)))) {
        throw new HttpError(404, `${key} vanished before ${name} could start from it.`);
      }
      await sandbox.prepare();
      this.running.set(name, sandbox);
      this.options.logger.info(`${name} started in ${Date.now() - startedAt} ms`);
      return sandbox;
    } catch (error) {
      await sandbox.delete().catch(() => undefined);
      throw error;
    }
  }

  /** Starts `sandbox` from the tar at `layer`; deleted again if it failed, for another attempt. */
  private async createFrom(sandbox: Sandbox, layer: string): Promise<void> {
    try {
      await sandbox.create(layer);
    } catch (error) {
      await sandbox.delete().catch(() => undefined);
      throw error;
    }
  }

  private applyNetwork(
    sandbox: Sandbox,
    { allowedHosts = [], baseUrls = {} }: SandboxNetwork,
  ): void {
    const defaults = this.options.network;
    sandbox.allowedHosts = [...new Set([...defaults.allowedHosts, ...allowedHosts])];
    sandbox.baseUrls = { ...defaults.baseUrls, ...baseUrls };
  }

  private save(sandbox: Sandbox, key: string): Promise<void> {
    return this.transfers.save(key, (layer) => sandbox.snapshot(layer));
  }
}
