import type { HarnessV1RequestTransformation } from '@ai-sdk/harness';

import type { ProxyRegistration, ProxySandbox } from '../../protocol/proxy.js';

import { HttpError } from '../../common/http-error.js';
import { PROTOCOL_HEADER, PROTOCOL_VERSION } from '../../protocol/version.js';

/**
 * The administration API of the egress proxy (`protocol/proxy.ts`), where the service registers the
 * sandboxes, what they may reach and their credentials. The proxy alone holds the credentials: the
 * service keeps none of them.
 */
export class ProxyAdmin {
  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}

  async register(name: string, registration: ProxyRegistration): Promise<void> {
    await this.call('PUT', name, { body: registration });
  }

  async setAllowedHosts(name: string, allowedHosts: readonly string[]): Promise<void> {
    await this.call('PUT', `${name}/network`, { body: { allowedHosts } });
  }

  async addTransformations(
    name: string,
    transformations: readonly HarnessV1RequestTransformation[],
  ): Promise<void> {
    await this.call('POST', `${name}/transformations`, { body: { transformations } });
  }

  async setTransformations(
    name: string,
    transformations: readonly HarnessV1RequestTransformation[],
  ): Promise<void> {
    await this.call('PUT', `${name}/transformations`, { body: { transformations } });
  }

  /** Whether one of `texts` holds a credential the proxy keeps for the sandbox `name`. */
  async holdsSecret(name: string, texts: readonly string[]): Promise<boolean> {
    const response = await this.call('POST', `${name}/screen`, { body: { texts } });
    return ((await response.json()) as { refused?: boolean }).refused === true;
  }

  /** Whether the proxy answers: its machine booted and its process listens. */
  async healthy(): Promise<boolean> {
    try {
      const response = await fetch(new URL('health', `${this.url.replace(/\/$/, '')}/`), {
        signal: AbortSignal.timeout(2000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * The sandboxes the proxy holds: `undefined` from a proxy of a version that cannot list them.
   */
  async list(): Promise<ProxySandbox[] | undefined> {
    try {
      const response = await this.call('GET', '');
      return ((await response.json()) as { sandboxes: ProxySandbox[] }).sandboxes;
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) return undefined;
      throw error;
    }
  }

  /**
   * Forgets the sandbox `name` and its credentials, or with `serial` only the registration that
   * {@link list} gave it. Idempotent.
   */
  async remove(name: string, serial?: number): Promise<void> {
    await this.call('DELETE', serial === undefined ? name : `${name}?serial=${serial}`);
  }

  /** Calls `/v1/sandboxes/<path>`, `/v1/sandboxes` itself for an empty `path`. */
  private async call(
    method: string,
    path: string,
    { body }: { body?: unknown } = {},
  ): Promise<Response> {
    let response: Response;
    try {
      const resource = path === '' ? 'v1/sandboxes' : `v1/sandboxes/${path}`;
      response = await fetch(new URL(resource, `${this.url.replace(/\/$/, '')}/`), {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      throw new HttpError(502, `The egress proxy could not be reached: ${String(error)}`);
    }
    if (response.ok) return response;
    const text = await response.text();
    let message = text;
    try {
      message = (JSON.parse(text) as { error?: string }).error ?? text;
    } catch {
      // Not the proxy's JSON.
    }
    // A sandbox the proxy does not know is one whose machine does not run.
    throw new HttpError(response.status === 404 ? 404 : 502, `Egress proxy: ${message.trim()}`);
  }
}
