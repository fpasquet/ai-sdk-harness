import type { HarnessV1RequestTransformation } from '@ai-sdk/harness';

import type { ProxyRegistration, ProxyUsage } from '../../protocol/proxy.js';

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

  /** The bytes the connections of the sandbox `name` carried through the proxy. */
  async usage(name: string): Promise<ProxyUsage> {
    return (await (await this.call('GET', `${name}/usage`)).json()) as ProxyUsage;
  }

  /**
   * Forgets the sandbox `name` and its credentials: what its connections carried until then,
   * `undefined` when the proxy knew none, or is of an earlier version. Idempotent.
   */
  async remove(name: string): Promise<ProxyUsage | undefined> {
    const response = await this.call('DELETE', name);
    if (response.status === 204) return undefined;
    return ((await response.json()) as { usage?: ProxyUsage }).usage;
  }

  /** Calls `/v1/sandboxes/<path>`. */
  private async call(
    method: string,
    path: string,
    { body }: { body?: unknown } = {},
  ): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(new URL(`v1/sandboxes/${path}`, `${this.url.replace(/\/$/, '')}/`), {
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
