import type { ClientRequest, IncomingMessage } from 'node:http';

import { createHmac } from 'node:crypto';
import { request as httpRequest } from 'node:http';

import type { AgentConfig, AgentDescription } from '../../protocol/agent.js';

import { HttpError } from '../../common/http-error.js';
import { AGENT_TOKEN_HEADER } from '../../protocol/agent.js';
import { PROTOCOL_HEADER, PROTOCOL_VERSION } from '../../protocol/version.js';

/**
 * The token of the agent of the sandbox `resource`: derived from the service's secret, so that
 * any replica of the service finds it again without keeping it, and a pod only ever learns its
 * own.
 */
export function agentToken(secret: string, resource: string): string {
  return createHmac('sha256', secret).update(`ai-sdk-sandbox-agent:${resource}`).digest('hex');
}

/** Where the agent of a running pod is reached, and what it is proven to with. */
export interface AgentEndpoint {
  host: string;
  port: number;
  token: string;
}

/** Why an agent did not answer: the pod is gone, or not up yet. */
const unreachable = (error: unknown): HttpError =>
  new HttpError(502, `The sandbox's pod did not answer: ${String(error)}`);

/** The HTTP API of the agent of one pod (`protocol/agent.ts`). */
export class AgentClient {
  constructor(readonly endpoint: AgentEndpoint) {}

  private get origin(): string {
    return `http://${this.endpoint.host}:${this.endpoint.port}`;
  }

  /** The agent's protocol, once it listens: `undefined` until then. */
  async health(): Promise<number | undefined> {
    try {
      const response = await fetch(`${this.origin}/health`, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) return undefined;
      return ((await response.json()) as { protocol?: number }).protocol;
    } catch {
      return undefined;
    }
  }

  async configure(config: AgentConfig): Promise<AgentDescription> {
    const response = await this.call('PUT', '/v1/config', config);
    return (await response.json()) as AgentDescription;
  }

  /** Waits for a process to exit, a few minutes at most: the agent's answer, as it is. */
  async wait(id: string): Promise<unknown> {
    return (await this.call('GET', `/v1/processes/${encodeURIComponent(id)}`)).json();
  }

  async kill(id: string): Promise<void> {
    await this.call('DELETE', `/v1/processes/${encodeURIComponent(id)}`);
  }

  async killAll(): Promise<void> {
    await this.call('DELETE', '/v1/processes');
  }

  /**
   * `POST /v1/exec`, its body the caller's to write: the agent's answer streams the process's
   * frames.
   */
  exec(): { request: ClientRequest; response: Promise<IncomingMessage> } {
    const request = httpRequest(`${this.origin}/v1/exec`, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/octet-stream' }),
    });
    const response = new Promise<IncomingMessage>((resolve, reject) => {
      request.once('response', resolve);
      request.once('error', (error) => reject(unreachable(error)));
    });
    return { request, response };
  }

  /** The headers of every call: the protocol, and the token that proves the caller is the service. */
  headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
      [AGENT_TOKEN_HEADER]: this.endpoint.token,
      ...extra,
    };
  }

  private async call(method: string, path: string, body?: unknown): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(`${this.origin}${path}`, {
        method,
        headers: this.headers(body === undefined ? {} : { 'content-type': 'application/json' }),
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      throw unreachable(error);
    }
    if (response.ok) return response;
    const text = await response.text();
    let message = text;
    try {
      message = (JSON.parse(text) as { error?: string }).error ?? text;
    } catch {
      // Not the agent's JSON.
    }
    throw new HttpError(response.status, message.trim());
  }
}
