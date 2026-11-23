import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

import type { KubernetesCredentials } from './credentials.js';

import { KubernetesError } from './kubernetes-error.js';

/** A condition of a resource's status, as Kubernetes reports them. */
export interface Condition {
  type: string;
  status: 'False' | 'True' | 'Unknown';
  reason?: string;
  message?: string;
}

/** The fields of a `Sandbox` of [agent-sandbox](https://agent-sandbox.sigs.k8s.io) the service reads. */
export interface SandboxResource {
  metadata: { name: string; labels?: Record<string, string>; deletionTimestamp?: string };
  spec: { operatingMode?: 'Running' | 'Suspended' };
  status?: { conditions?: Condition[]; podIPs?: string[] };
}

/** The fields of a `VolumeSnapshot` the service reads. */
export interface VolumeSnapshotResource {
  metadata: { name: string; labels?: Record<string, string> };
  status?: { readyToUse?: boolean; error?: { message?: string } };
}

const SANDBOXES = 'apis/agents.x-k8s.io/v1beta1';
const SNAPSHOTS = 'apis/snapshot.storage.k8s.io/v1';

/** The longest a call to the API is waited for. */
const CALL_TIMEOUT_MS = 30_000;

interface Answer {
  status: number;
  body: string;
}

/**
 * The calls of the Kubernetes API the service makes, over its REST interface: no client library, so
 * that the service keeps no runtime dependency. Everything lives in one namespace, the sandboxes'.
 */
export class KubernetesApi {
  /**
   * @param options `endpoint`: the API's root, `https://kubernetes.default.svc` in the cluster.
   *   `namespace`: where the sandboxes live.
   */
  constructor(
    private readonly options: {
      endpoint: string;
      namespace: string;
      credentials: KubernetesCredentials;
    },
  ) {}

  /** The sandbox `name`, or `undefined` when there is none. */
  getSandbox(name: string): Promise<SandboxResource | undefined> {
    return this.read<SandboxResource>(this.path(SANDBOXES, 'sandboxes', name));
  }

  async createSandbox(body: Record<string, unknown>): Promise<void> {
    await this.call('POST', this.path(SANDBOXES, 'sandboxes'), { body });
  }

  /** Merges `patch` into the sandbox `name`. */
  async patchSandbox(name: string, patch: Record<string, unknown>): Promise<void> {
    await this.call('PATCH', this.path(SANDBOXES, 'sandboxes', name), { body: patch });
  }

  /**
   * Deletes the sandbox `name`: its pod, and its volumes, which it owns, go with it. Nothing when
   * there is none.
   */
  async deleteSandbox(name: string): Promise<void> {
    await this.call('DELETE', this.path(SANDBOXES, 'sandboxes', name), { ignore: [404] });
  }

  getSnapshot(name: string): Promise<undefined | VolumeSnapshotResource> {
    return this.read<VolumeSnapshotResource>(this.path(SNAPSHOTS, 'volumesnapshots', name));
  }

  async createSnapshot(body: Record<string, unknown>): Promise<void> {
    await this.call('POST', this.path(SNAPSHOTS, 'volumesnapshots'), { body });
  }

  async deleteSnapshot(name: string): Promise<void> {
    await this.call('DELETE', this.path(SNAPSHOTS, 'volumesnapshots', name), { ignore: [404] });
  }

  private path(api: string, kind: string, name?: string): string {
    const collection = `/${api}/namespaces/${this.options.namespace}/${kind}`;
    return name === undefined ? collection : `${collection}/${name}`;
  }

  private async read<T>(path: string): Promise<T | undefined> {
    const answer = await this.call('GET', path, { ignore: [404] });
    return answer.status === 404 ? undefined : (JSON.parse(answer.body) as T);
  }

  /** Calls the API, an answer outside 2xx and `ignore` thrown as a {@link KubernetesError}. */
  private async call(
    method: string,
    path: string,
    { body, ignore = [] }: { body?: Record<string, unknown>; ignore?: readonly number[] } = {},
  ): Promise<Answer> {
    const answer = await this.send(method, path, body);
    if ((answer.status >= 200 && answer.status < 300) || ignore.includes(answer.status)) {
      return answer;
    }
    let message = answer.body.slice(0, 500);
    try {
      message = (JSON.parse(answer.body) as { message?: string }).message ?? message;
    } catch {
      // Not a Status object: the body as it came.
    }
    throw new KubernetesError(answer.status, `${method} ${path}: ${message}`);
  }

  private send(method: string, path: string, body?: Record<string, unknown>): Promise<Answer> {
    const url = new URL(path.slice(1), `${this.options.endpoint.replace(/\/$/, '')}/`);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const bearer = this.options.credentials.bearer();
    const headers: Record<string, string> = {
      accept: 'application/json',
      ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }),
      ...(payload === undefined
        ? {}
        : {
            'content-type':
              method === 'PATCH' ? 'application/merge-patch+json' : 'application/json',
            'content-length': String(Buffer.byteLength(payload)),
          }),
    };
    const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
    return new Promise<Answer>((resolve, reject) => {
      const call = request(
        url,
        { method, headers, ca: this.options.credentials.ca, timeout: CALL_TIMEOUT_MS },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () =>
            resolve({ status: response.statusCode ?? 500, body: Buffer.concat(chunks).toString() }),
          );
          response.on('error', reject);
        },
      );
      call.on('timeout', () => call.destroy(new Error(`${method} ${path} timed out.`)));
      call.on('error', reject);
      call.end(payload);
    });
  }
}
