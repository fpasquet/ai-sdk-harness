import type { HarnessV1PortEndpoint, HarnessV1RequestTransformation } from '@ai-sdk/harness';

import { HarnessSandboxAuthenticationError } from '@ai-sdk/harness';

import type { SandboxCommand, SandboxDescription, SandboxNetwork } from '../../protocol/api.js';
import type { IdentityToken } from './identity-token.js';

import { PROTOCOL_HEADER, PROTOCOL_VERSION, SERVICE_TOKEN_HEADER } from '../../protocol/version.js';
import { CloudRunSandboxServiceError } from '../errors/cloud-run-sandbox-service-error.js';
import { CLOUD_RUN_SANDBOX_PROVIDER_ID } from '../provider-id.js';

interface CallOptions {
  body?: unknown;
  abortSignal?: AbortSignal;
  /** Statuses that are an answer rather than an error. */
  accept?: readonly number[];
}

const encoder = new TextEncoder();

/**
 * The HTTP API of the sandbox service (`ai-sdk-sandbox-cloud-run serve`). Each call carries an
 * identity token when there is one: Cloud Run's IAM checks it. Nothing else of this process goes
 * to the service, but the request transformations it is handed.
 */
export class SandboxServiceClient {
  private readonly base: URL;

  private readonly serviceToken?: string;
  private readonly token?: IdentityToken;

  /**
   * @param url The service's URL.
   * @param credentials The identity token Cloud Run's IAM checks, and the secret the service may
   *   share with its callers.
   */
  constructor(
    url: string,
    { token, serviceToken }: { serviceToken?: string; token?: IdentityToken } = {},
  ) {
    this.base = new URL(url.endsWith('/') ? url : `${url}/`);
    this.token = token;
    this.serviceToken = serviceToken;
  }

  /** The service's URL. */
  get baseUrl(): string {
    return this.base.toString();
  }

  /** Creates the sandbox `name`, from a template when given. */
  async create(
    name: string,
    options: SandboxNetwork & { abortSignal?: AbortSignal; template?: string },
  ): Promise<SandboxDescription> {
    const { abortSignal, ...body } = options;
    const response = await this.call('POST', 'v1/sandboxes', {
      body: { name, ...body },
      abortSignal,
    });
    return (await response.json()) as SandboxDescription;
  }

  /** The sandbox `name`, running or brought back from its snapshot: `undefined` when there is none. */
  async resume(
    name: string,
    options: SandboxNetwork & { abortSignal?: AbortSignal },
  ): Promise<SandboxDescription | undefined> {
    const { abortSignal, ...body } = options;
    const response = await this.call('POST', `v1/sandboxes/${name}/resume`, {
      body,
      abortSignal,
      accept: [404],
    });
    return response.status === 404 ? undefined : ((await response.json()) as SandboxDescription);
  }

  /** Saves the sandbox to its snapshot and frees the instance of it. */
  async suspend(name: string): Promise<void> {
    await this.call('POST', `v1/sandboxes/${name}/suspend`);
  }

  /** Deletes the sandbox, its snapshot included. */
  async remove(name: string): Promise<void> {
    await this.call('DELETE', `v1/sandboxes/${name}`);
  }

  /**
   * Starts `command`, `stdin` as its standard input: the response streams its output as frames,
   * and names the process in `x-process-id`.
   */
  exec(
    name: string,
    { command, stdin = new Uint8Array() }: { command: SandboxCommand; stdin?: Uint8Array },
    abortSignal?: AbortSignal,
  ): Promise<Response> {
    const line = encoder.encode(`${JSON.stringify(command)}\n`);
    const body = new Uint8Array(line.byteLength + stdin.byteLength);
    body.set(line);
    body.set(stdin, line.byteLength);
    return this.call('POST', `v1/sandboxes/${name}/exec`, { body, abortSignal });
  }

  /** Waits for a process to exit, a few minutes at most: its exit code, or `undefined`. */
  async wait(name: string, id: string): Promise<number | undefined> {
    const response = await this.call('GET', `v1/sandboxes/${name}/processes/${id}`);
    const { exitCode } = (await response.json()) as { exitCode?: number };
    return exitCode;
  }

  /** Stops a process and everything it started. A process already gone is no error. */
  async kill(name: string, id: string): Promise<void> {
    await this.call('DELETE', `v1/sandboxes/${name}/processes/${id}`, { accept: [404] });
  }

  /** Stops every process started in the sandbox. */
  async killAll(name: string): Promise<void> {
    await this.call('DELETE', `v1/sandboxes/${name}/processes`);
  }

  async addTransformations(
    name: string,
    transformations: readonly HarnessV1RequestTransformation[],
  ): Promise<void> {
    await this.call('POST', `v1/sandboxes/${name}/transformations`, { body: { transformations } });
  }

  async setTransformations(
    name: string,
    transformations: readonly HarnessV1RequestTransformation[],
  ): Promise<void> {
    await this.call('PUT', `v1/sandboxes/${name}/transformations`, { body: { transformations } });
  }

  /** Replaces the hosts the sandbox may reach, those the service allows every sandbox aside. */
  async setAllowedHosts(name: string, allowedHosts: readonly string[]): Promise<void> {
    await this.call('PUT', `v1/sandboxes/${name}/network`, { body: { allowedHosts } });
  }

  /** Saves the running sandbox as the template `id`. */
  async saveTemplate(name: string, id: string, abortSignal?: AbortSignal): Promise<void> {
    await this.call('POST', `v1/sandboxes/${name}/template`, { body: { id }, abortSignal });
  }

  async templateExists(id: string, abortSignal?: AbortSignal): Promise<boolean> {
    const response = await this.call('GET', `v1/templates/${id}`, { abortSignal, accept: [404] });
    return response.status !== 404;
  }

  async deleteTemplate(id: string): Promise<void> {
    await this.call('DELETE', `v1/templates/${id}`);
  }

  /**
   * Where a port of the sandbox is reached: a WebSocket through the service. The token is read
   * anew each time the harness connects: a bridge connection outlives a token.
   */
  portEndpoint(
    name: string,
    port: number,
    protocol: 'http' | 'https' | 'ws',
  ): HarnessV1PortEndpoint {
    const url = new URL(`v1/sandboxes/${name}/ports/${port}`, this.base);
    if (protocol === 'ws') url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const headers: Record<string, string> = this.fixedHeaders();
    const token = this.token;
    if (token !== undefined) {
      Object.defineProperty(headers, 'Authorization', {
        enumerable: true,
        get: () => `Bearer ${token.current()}`,
      });
    }
    return { url: url.toString(), headers };
  }

  /** What every call carries but the identity token: the protocol it speaks, the service token. */
  private fixedHeaders(): Record<string, string> {
    return {
      [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
      ...(this.serviceToken === undefined ? {} : { [SERVICE_TOKEN_HEADER]: this.serviceToken }),
    };
  }

  private async call(method: string, path: string, options: CallOptions = {}): Promise<Response> {
    const { body, abortSignal, accept = [] } = options;
    const headers: Record<string, string> = this.fixedHeaders();
    if (this.token !== undefined) headers['authorization'] = `Bearer ${await this.token.get()}`;
    if (body !== undefined && !(body instanceof Uint8Array)) {
      headers['content-type'] = 'application/json';
    }
    const response = await fetch(new URL(path, this.base), {
      method,
      headers,
      body: body instanceof Uint8Array ? (body as Uint8Array<ArrayBuffer>) : JSON.stringify(body),
      signal: abortSignal,
    });
    if (response.ok || accept.includes(response.status)) return response;
    throw await this.failure(`${method} /${path}`, response);
  }

  private async failure(request: string, response: Response): Promise<Error> {
    const text = await response.text();
    if (response.status === 401 || response.status === 403) {
      return new HarnessSandboxAuthenticationError({
        sandboxProviderId: CLOUD_RUN_SANDBOX_PROVIDER_ID,
        message: `The Cloud Run sandbox service refused ${request} (${response.status}): grant the caller roles/run.invoker on the service, or check the \`auth\` option.`,
      });
    }
    let message = text;
    try {
      message = (JSON.parse(text) as { error?: string }).error ?? text;
    } catch {
      // Not the service's JSON: Cloud Run's own error page, say.
    }
    return new CloudRunSandboxServiceError(request, response.status, message.trim());
  }
}
