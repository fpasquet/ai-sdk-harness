import { execFileSync } from 'node:child_process';
import { chownSync, existsSync, mkdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

import type { Logger } from '../common/logger.js';
import type { AgentSettings } from './agent.js';
import type { CommandUser } from './processes.js';

import { AGENT_TOKEN_METADATA_KEY, DEFAULT_AGENT_PORT } from '../protocol/agent.js';

type Environment = Readonly<Record<string, string | undefined>>;

const METADATA = 'http://metadata.google.internal/computeMetadata/v1/instance/attributes/';

/** How long the agent tries to read its token from the metadata server, as the machine boots. */
const METADATA_ATTEMPTS = 30;

/** The token the service gave the machine, in its instance metadata. */
async function metadataToken(url: string): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(`${url}${AGENT_TOKEN_METADATA_KEY}`, {
        headers: { 'metadata-flavor': 'Google' },
      });
      if (response.ok) return (await response.text()).trim();
      if (response.status === 404) {
        throw new Error(
          `The instance has no \`${AGENT_TOKEN_METADATA_KEY}\` metadata: it was not created by the sandbox service.`,
        );
      }
    } catch (error) {
      if (attempt >= METADATA_ATTEMPTS) throw error;
    }
    await sleep(1000);
  }
}

/** The ids of `user`, from `id`. */
function idsOf(user: string): CommandUser {
  const id = (flag: string): number =>
    Number(execFileSync('id', [flag, user], { encoding: 'utf8' }).trim());
  return { uid: id('-u'), gid: id('-g') };
}

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

/** Whom the commands run as: `SANDBOX_USER` (`agent`) as root, the agent's own user otherwise. */
function commandIdentity(env: Environment): {
  commandUser?: CommandUser;
  home: string;
  user: string;
} {
  if (process.getuid?.() === 0) {
    const user = env['SANDBOX_USER'] ?? 'agent';
    return { user, commandUser: idsOf(user), home: env['SANDBOX_HOME'] ?? `/home/${user}` };
  }
  return {
    user: env['SANDBOX_USER'] ?? env['USER'] ?? 'agent',
    home: env['SANDBOX_HOME'] ?? env['HOME'] ?? '/tmp',
  };
}

/**
 * The agent's settings, from its environment, which the image's systemd unit sets: every variable
 * has a default fit for a machine of the sandbox image. As root, the commands run as `SANDBOX_USER`
 * (`agent`), and its home and the working directory are made, its own.
 */
export async function agentSettings(env: Environment, logger: Logger): Promise<AgentSettings> {
  const { user, commandUser, home } = commandIdentity(env);
  const workingDirectory = env['SANDBOX_WORKDIR'] ?? '/workspace';
  for (const directory of [home, workingDirectory]) {
    mkdirSync(directory, { recursive: true });
    if (commandUser !== undefined) chownSync(directory, commandUser.uid, commandUser.gid);
  }
  return {
    token: env['SANDBOX_AGENT_TOKEN'] ?? (await metadataToken(env['METADATA_URL'] ?? METADATA)),
    user,
    home,
    workingDirectory,
    path: env['SANDBOX_PATH'] ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    stateDirectory: env['SANDBOX_STATE_DIR'] ?? '/var/lib/ai-sdk-sandbox',
    commandUser,
    configureDocker:
      env['SANDBOX_CONFIGURE_DOCKER'] !== 'false' &&
      commandUser !== undefined &&
      existsSync('/usr/bin/dockerd'),
    logger,
  };
}
