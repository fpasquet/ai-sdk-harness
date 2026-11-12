/**
 * The HTTP API of the agent that runs in each sandbox's pod (`ai-sdk-sandbox-gke agent`), which
 * only the sandbox service calls:
 *
 * - `GET /health`: `{ status, protocol, version }`, unauthenticated;
 * - `PUT /v1/config`, an {@link AgentConfig}: answers the {@link AgentDescription};
 * - `POST /v1/exec`: a line of JSON, a `SandboxCommand`, then the command's standard input; the
 *   answer streams the frames of `frames.ts`, the process named in `x-process-id`;
 * - `GET /v1/processes/:id`: waits for the process to exit, a few minutes at most:
 *   `{ exitCode }`, or `{ running: true }`;
 * - `DELETE /v1/processes/:id`, `DELETE /v1/processes`: stop one process, or every one;
 * - `GET /v1/ports/:port/…` with `Upgrade`: the request passed on to `127.0.0.1:<port>`.
 */

/** The header every call but the health check carries: the agent's token, see {@link agentToken}. */
export const AGENT_TOKEN_HEADER = 'x-ai-sdk-sandbox-agent-token';

/** The port the agent listens on, in its pod. */
export const DEFAULT_AGENT_PORT = 8100;

/** How a sandbox's commands reach the network: what the service tells its agent. */
export interface AgentConfig {
  /** The egress proxy, as the pod reaches it, by address: `http://10.8.0.12:3128`. */
  proxy: string;
  /** Base URL variables, routed through the proxy, and where each really leads. */
  baseUrls: Readonly<Record<string, string>>;
}

/** Where a sandbox's commands run: the agent's answer to its configuration. */
export interface AgentDescription {
  home: string;
  workingDirectory: string;
}
