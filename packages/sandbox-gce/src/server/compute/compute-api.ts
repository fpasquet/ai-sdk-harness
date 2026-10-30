import type { AccessToken } from './access-token.js';

import { ComputeError } from './compute-error.js';

/** The fields of a Compute Engine instance the service reads. */
export interface Instance {
  name: string;
  /** `PROVISIONING`, `STAGING`, `RUNNING`, `STOPPING`, `TERMINATED`, `SUSPENDING`, `SUSPENDED`… */
  status: string;
  labels?: Record<string, string>;
  /** What the labels are changed with: Compute Engine refuses a change made on older ones. */
  labelFingerprint?: string;
  networkInterfaces?: { networkIP?: string }[];
  metadata?: InstanceMetadata;
  /** When the instance was made: an RFC 3339 timestamp. */
  creationTimestamp?: string;
}

/** The metadata of an instance: its `fingerprint` must be given back to change it. */
export interface InstanceMetadata {
  fingerprint?: string;
  items?: { key: string; value?: string }[];
}

/** The fields of an image the service reads. */
export interface Image {
  name: string;
  selfLink: string;
  status?: string;
}

interface Operation {
  name: string;
  status: string;
  selfLink: string;
  error?: { errors?: { code?: string; message?: string }[] };
  httpErrorStatusCode?: number;
}

/** The longest an operation is waited for: creating an image takes some minutes. */
const OPERATION_TIMEOUT_MS = 15 * 60_000;

/**
 * Whether a change is waited for until it is done, or only until Compute Engine accepted it: a stop
 * or a deletion goes on for some 50 s after the guest is off, which no caller needs to wait for.
 */
export interface ChangeOptions {
  wait?: boolean;
}

/**
 * The calls of the [Compute Engine API](https://cloud.google.com/compute/docs/reference/rest/v1)
 * the service makes, over its REST interface: no client library, so that the service keeps no
 * runtime dependency. Every change is an operation, waited for until it is done unless told not to.
 */
export class ComputeApi {
  /**
   * @param options `endpoint`: the API's root, `https://compute.googleapis.com/compute/v1` but in
   *   tests. `project` and `zone`: where the sandboxes' machines live.
   */
  constructor(
    private readonly options: {
      endpoint: string;
      project: string;
      zone: string;
      token: AccessToken;
    },
  ) {}

  /** The instance `name`, or `undefined` when there is none. */
  getInstance(name: string): Promise<Instance | undefined> {
    return this.read<Instance>(this.zonal(`instances/${name}`));
  }

  /** The instances of the zone whose label `key` is `value`, every page of them. */
  async listInstances(key: string, value: string): Promise<Instance[]> {
    const instances: Instance[] = [];
    let pageToken: string | undefined;
    do {
      const query = new URLSearchParams({ filter: `labels.${key} = "${value}"` });
      if (pageToken !== undefined) query.set('pageToken', pageToken);
      const page = (await this.read<{ items?: Instance[]; nextPageToken?: string }>(
        `${this.zonal('instances')}?${query.toString()}`,
      )) ?? { items: [] };
      instances.push(...(page.items ?? []));
      pageToken = page.nextPageToken;
    } while (pageToken !== undefined);
    return instances;
  }

  async insertInstance(
    body: Record<string, unknown>,
    { wait = true }: ChangeOptions = {},
  ): Promise<void> {
    await this.change('POST', this.zonal('instances'), { body, wait });
  }

  async startInstance(name: string, { wait = true }: ChangeOptions = {}): Promise<void> {
    await this.change('POST', this.zonal(`instances/${name}/start`), { wait });
  }

  async resumeInstance(name: string): Promise<void> {
    await this.change('POST', this.zonal(`instances/${name}/resume`));
  }

  async stopInstance(name: string, { wait = true }: ChangeOptions = {}): Promise<void> {
    await this.change('POST', this.zonal(`instances/${name}/stop`), { wait });
  }

  /** Changes how the stopped instance `name` is provisioned: from Spot to standard, say. */
  async setScheduling(name: string, scheduling: Record<string, unknown>): Promise<void> {
    await this.change('POST', this.zonal(`instances/${name}/setScheduling`), { body: scheduling });
  }

  /**
   * Replaces the metadata of the instance `name`. Refused with a 412 when it changed since it was
   * read with `fingerprint`.
   */
  async setMetadata(name: string, metadata: InstanceMetadata): Promise<void> {
    await this.change('POST', this.zonal(`instances/${name}/setMetadata`), { body: metadata });
  }

  /**
   * Replaces the labels of the instance `name`. Refused with a 412 when they changed since they were
   * read with `fingerprint`: of two changes made on the same labels, one only goes through.
   */
  async setLabels(
    name: string,
    labels: Record<string, string>,
    fingerprint: string | undefined,
  ): Promise<void> {
    await this.change('POST', this.zonal(`instances/${name}/setLabels`), {
      body: { labels, labelFingerprint: fingerprint },
    });
  }

  /** Deletes the instance `name` and its disks set to go with it. Nothing when there is none. */
  async deleteInstance(name: string, { wait = true }: ChangeOptions = {}): Promise<void> {
    await this.change('DELETE', this.zonal(`instances/${name}`), { ignore: [404], wait });
  }

  /**
   * An image, `path` relative to the API's root (`projects/<project>/global/images/<name>`, or
   * `…/images/family/<family>` for the latest of a family): `undefined` when there is none.
   */
  getImage(path: string): Promise<Image | undefined> {
    return this.read<Image>(`${this.options.endpoint}/${path}`);
  }

  /** The URL of the image `name` of the service's project. */
  imagePath(name: string): string {
    return `projects/${this.options.project}/global/images/${name}`;
  }

  /** Saves the boot disk of the stopped instance `disk` as the image `name`. */
  async insertImage(name: string, disk: string, labels: Record<string, string>): Promise<void> {
    await this.change('POST', `${this.global}/images`, {
      body: { name, labels, sourceDisk: `zones/${this.options.zone}/disks/${disk}` },
    });
  }

  async deleteImage(name: string): Promise<void> {
    await this.change('DELETE', `${this.global}/images/${name}`, { ignore: [404] });
  }

  /** The URL of `resource` in the service's zone, relative to the project. */
  private zonal(resource: string): string {
    return `${this.global.replace(/\/global$/, '')}/zones/${this.options.zone}/${resource}`;
  }

  private get global(): string {
    return `${this.options.endpoint}/projects/${this.options.project}/global`;
  }

  private async read<T>(url: string): Promise<T | undefined> {
    const response = await this.call('GET', url);
    if (response.status === 404) return undefined;
    return (await this.parse(response)) as T;
  }

  /**
   * Starts an operation and waits until it is done, unless `wait` is false. Statuses in `ignore`
   * end it at once.
   */
  private async change(
    method: string,
    url: string,
    {
      body,
      ignore = [],
      wait = true,
    }: { body?: unknown; ignore?: readonly number[]; wait?: boolean } = {},
  ): Promise<void> {
    const response = await this.call(method, url, body);
    if (ignore.includes(response.status)) return;
    const started = (await this.parse(response)) as Operation;
    // An operation done at once may have failed: read it even when not waiting.
    if (wait || started.status === 'DONE') await this.wait(started);
  }

  private async wait(started: Operation): Promise<void> {
    const deadline = Date.now() + OPERATION_TIMEOUT_MS;
    let operation = started;
    while (operation.status !== 'DONE') {
      if (Date.now() > deadline) {
        throw new ComputeError(504, `operation ${operation.name} is still running.`);
      }
      // `wait` answers once the operation is done, or after some two minutes.
      const response = await this.call('POST', `${operation.selfLink ?? ''}/wait`);
      operation = (await this.parse(response)) as Operation;
    }
    const [first] = operation.error?.errors ?? [];
    if (first !== undefined) {
      throw new ComputeError(
        operation.httpErrorStatusCode ?? 500,
        `${first.code ?? 'ERROR'}: ${first.message ?? 'the operation failed.'}`,
        first.code,
      );
    }
  }

  private async call(method: string, url: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = {};
    const token = await this.options.token.get();
    if (token !== undefined) headers['authorization'] = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    return fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  private async parse(response: Response): Promise<unknown> {
    const text = await response.text();
    if (response.ok) return JSON.parse(text) as unknown;
    let message = text;
    try {
      message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? text;
    } catch {
      // Not the API's JSON.
    }
    throw new ComputeError(response.status, message.trim());
  }
}
