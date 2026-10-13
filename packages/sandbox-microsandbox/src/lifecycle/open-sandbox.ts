import type { MicrosandboxConnectionSettings } from '../microsandbox-settings.js';
import type { MicrosandboxConnection } from '../transport/microsandbox-connection.js';

import { MicrosandboxNetworkSandboxSession } from '../session/microsandbox-network-sandbox-session.js';
import {
  DOCKER_MARKER,
  INSTALL_DOCKER,
  PREPARE_WORKSPACE,
  WORKSPACE,
} from '../transport/sandbox-scripts.js';

/** Setup commands run as root: they install what the sandbox's user cannot. */
const SETUP_USER = 'root';

/**
 * Makes a new sandbox ready: its working directory, owned by `user`, unless a host directory is
 * mounted there, Docker Engine when it runs `docker`, then each of `setup`, in order, stopping at
 * the first failure.
 */
export async function prepareSandbox(
  connection: MicrosandboxConnection,
  {
    user,
    workspaceMounted,
    docker,
    setup,
    abortSignal,
  }: {
    user?: string;
    workspaceMounted: boolean;
    docker: boolean;
    setup: readonly string[];
    abortSignal?: AbortSignal;
  },
): Promise<void> {
  if (!workspaceMounted) {
    await connection.check(['sh', '-c', PREPARE_WORKSPACE, WORKSPACE, user ?? ''], {
      user: SETUP_USER,
    });
  }
  if (docker) {
    abortSignal?.throwIfAborted();
    await connection.check(['sh', '-c', INSTALL_DOCKER, DOCKER_MARKER, user ?? ''], {
      user: SETUP_USER,
    });
  }
  for (const command of setup) {
    abortSignal?.throwIfAborted();
    await connection.check(['sh', '-c', command], { cwd: WORKSPACE, user: SETUP_USER });
  }
}

/** A session on the existing sandbox `connection` reaches, with the ports it was created with. */
export async function openSession(
  connection: MicrosandboxConnection,
  settings: MicrosandboxConnectionSettings,
): Promise<MicrosandboxNetworkSandboxSession> {
  const ports = await connection.publishedPorts();
  return new MicrosandboxNetworkSandboxSession(
    {
      connection,
      workingDirectory: WORKSPACE,
      processes: new Set(),
      docker: await connection.runsDocker(),
    },
    ports,
    settings.brokerCredentials ?? true,
  );
}
