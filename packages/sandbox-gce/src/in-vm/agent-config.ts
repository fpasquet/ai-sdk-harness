import { execFileSync } from 'node:child_process';
import { chownSync, existsSync, mkdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

import type { Logger } from '../common/logger.js';
import type { AgentSettings } from './agent.js';
import type { CommandUser } from './processes.js';

import {
  AGENT_TOKEN_METADATA_KEY,
  DEFAULT_AGENT_PORT,
  IDLE_POWER_OFF_METADATA_KEY,
} from '../protocol/agent.js';

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

/**
 * The minutes after its boot the machine is powered off unless configured, from its instance
 * metadata: read once, the metadata server having just answered the token. `undefined` when the
 * key is missing, or cannot be read: the machine then runs on, as before the key was.
 */
async function metadataIdleMinutes(url: string, logger: Logger): Promise<number | undefined> {
  try {
    const response = await fetch(`${url}${IDLE_POWER_OFF_METADATA_KEY}`, {
      headers: { 'metadata-flavor': 'Google' },
      signal: AbortSignal.timeout(5000),
    });
    if (response.status === 404) return undefined;
    const text = (await response.text()).trim();
    const minutes = Number(text);
    if (response.ok && Number.isInteger(minutes) && minutes > 0) return minutes;
    logger.warn(`\`${IDLE_POWER_OFF_METADATA_KEY}\` is not a positive integer: \`${text}\`.`);
  } catch (error) {
    logger.warn(`\`${IDLE_POWER_OFF_METADATA_KEY}\` could not be read: ${String(error)}`);
  }
  return undefined;
}

/**
 * The token, from the environment or else the instance metadata, and with the latter, as root, when
 * to power the machine off unless configured.
 */
async function fromMetadata(
  env: Environment,
  logger: Logger,
): Promise<Pick<AgentSettings, 'idlePowerOff' | 'token'>> {
  const given = env['SANDBOX_AGENT_TOKEN'];
  if (given !== undefined) return { token: given };
  const url = env['METADATA_URL'] ?? METADATA;
  const token = await metadataToken(url);
  // Only root powers the machine off: an agent run by hand, or in tests, never does.
  if (process.getuid?.() !== 0) return { token };
  const minutes = await metadataIdleMinutes(url, logger);
  if (minutes === undefined) return { token };
  const runDirectory = env['SANDBOX_RUN_DIR'] ?? '/run/ai-sdk-sandbox';
  return { token, idlePowerOff: { afterMs: minutes * 60_000, runDirectory } };
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
    ...(await fromMetadata(env, logger)),
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
