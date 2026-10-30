/**
 * The HTTP API of the agent that runs in each sandbox's machine (`ai-sdk-sandbox-gce agent`), which
 * only the sandbox service calls:
 *
 * - `GET /health`: `{ status, protocol, version }`, unauthenticated;
 * - `PUT /v1/config`, an {@link AgentConfig}: answers the {@link AgentDescription};
 * - `POST /v1/exec`: a line of JSON, a `SandboxCommand`, then the command's standard input; the
 *   answer streams the frames of `frames.ts`, the process named in `x-process-id`;
 * - `GET /v1/processes/:id`: waits for the process to exit, a few minutes at most:
 *   `{ exitCode }`, or `{ running: true }`;
 * - `POST /v1/processes/:id/stdin?offset=…`: bytes of the standard input of a process started with
 *   `stdin`, from that offset on; `DELETE /v1/processes/:id/stdin` ends it;
 * - `DELETE /v1/processes/:id`, `DELETE /v1/processes`: stop one process, or every one;
 * - `GET /v1/ports/:port/…` with `Upgrade`: the request passed on to `127.0.0.1:<port>`.
 */

/** The header every call but the health check carries: the agent's token, see {@link agentToken}. */
export const AGENT_TOKEN_HEADER = 'x-ai-sdk-sandbox-agent-token';

/** The instance metadata key the agent reads its token from, when its environment has none. */
export const AGENT_TOKEN_METADATA_KEY = 'ai-sdk-sandbox-agent-token';

/**
 * The instance metadata key of a machine booted ahead of a sandbox: the minutes after its boot its
 * agent powers it off unless configured meanwhile. Never without it.
 */
export const IDLE_POWER_OFF_METADATA_KEY = 'ai-sdk-sandbox-idle-poweroff-minutes';

/** The port the agent listens on, in its machine. */
export const DEFAULT_AGENT_PORT = 8100;

/** How a sandbox's commands reach the network: what the service tells its agent. */
export interface AgentConfig {
  /** The egress proxy, as the machine reaches it: `http://10.0.0.2:3128`. */
  proxy: string;
  /** Base URL variables, routed through the proxy, and where each really leads. */
  baseUrls: Readonly<Record<string, string>>;
}

/** Where a sandbox's commands run: the agent's answer to its configuration. */
export interface AgentDescription {
  home: string;
  workingDirectory: string;
}
