import { mkdirSync } from 'node:fs';

import type { Logger } from '../common/logger.js';
import type { AgentSettings } from './agent.js';

import { DEFAULT_AGENT_PORT } from '../protocol/agent.js';

type Environment = Readonly<Record<string, string | undefined>>;

/** Where the agent listens. */
export interface AgentListenConfig {
  port: number;
  host: string;
}

export function agentListenConfig(env: Environment): AgentListenConfig {
  return {
    port: Number.parseInt(env['SANDBOX_AGENT_PORT'] ?? String(DEFAULT_AGENT_PORT), 10),
    host: env['HOST'] ?? '0.0.0.0',
  };
}

/** The token the service derived for this pod, in its environment. */
function agentToken(env: Environment): string {
  const token = env['SANDBOX_AGENT_TOKEN'];
  if (token === undefined || token === '') {
    throw new Error(
      'SANDBOX_AGENT_TOKEN is required: the pod was not created by the sandbox service.',
    );
  }
  return token;
}

/**
 * The agent's settings, from its environment, which the service sets in the pod: every variable
 * but the token has a default fit for a pod of the sandbox image. The agent and its commands run
 * as the pod's user, never root; its home and the working directory are made.
 */
export function agentSettings(env: Environment, logger: Logger): AgentSettings {
  const home = env['SANDBOX_HOME'] ?? env['HOME'] ?? '/tmp';
  const workingDirectory = env['SANDBOX_WORKDIR'] ?? `${home}/workspace`;
  for (const directory of [home, workingDirectory]) mkdirSync(directory, { recursive: true });
  return {
    token: agentToken(env),
    user: env['SANDBOX_USER'] ?? env['USER'] ?? 'agent',
    home,
    workingDirectory,
    path:
      env['SANDBOX_PATH'] ??
      `${home}/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    stateDirectory: env['SANDBOX_STATE_DIR'] ?? '/tmp/ai-sdk-sandbox',
    logger,
  };
}
