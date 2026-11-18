import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  DockerConnectionSettings,
  DockerNetworkSandboxSessionCreateOptions,
  DockerNetworkSandboxSessionResumeOptions,
} from '../docker-settings.js';
import type { PortForward } from '../network/port-forwards.js';
import type { DockerSandboxResources } from '../session/docker-network-sandbox-session.js';

import { DockerSandboxNotFoundError } from '../errors/docker-sandbox-not-found-error.js';
import { BLOCKED_FILE } from '../network/blocked-requests.js';
import { writeNetworkPolicy } from '../network/network-policy.js';
import { forwardsOf } from '../network/port-forwards.js';
import {
  DockerNetworkSandboxSession,
  removeSandbox,
} from '../session/docker-network-sandbox-session.js';
import { assertEnvNames } from '../session/docker-sandbox-session.js';
import { DockerCli } from '../transport/docker-cli.js';
import {
  checkMounts,
  checkSandboxId,
  LABEL,
  PROXY_ALIAS,
  proxyRunArgs,
  sandboxRunArgs,
} from './run-args.js';

/** What a resume reads of a sandbox, kept in its state directory. */
interface SandboxState {
  workingDirectory: string;
  forwards: PortForward[];
}

const STATE_FILE = 'sandbox.json';

/**
 * The script of the egress proxy, beside this package's code: `.js` once built, `.ts` in this
 * repository's tests, which Node.js runs as it is.
 */
const PROXY_SOURCE = fileURLToPath(
  new URL(`../proxy/egress-proxy${extname(fileURLToPath(import.meta.url))}`, import.meta.url),
);

/** The directory of this host where the sandboxes keep their state. */
function stateRoot(
  { stateDirectory }: DockerConnectionSettings,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  if (stateDirectory !== undefined) return stateDirectory;
  const base = env['XDG_STATE_HOME'] ?? join(homedir(), '.local', 'state');
  return join(base, 'ai-sdk-sandbox-docker-engine');
}

/** The names of what a sandbox is made of. */
function namesOf(sandboxId: string, settings: DockerConnectionSettings) {
  return {
    proxy: `${sandboxId}-egress`,
    network: `${sandboxId}-net`,
    stateDirectory: join(stateRoot(settings), sandboxId),
  };
}

/** The user the proxy runs as: this process's, so that it writes in the state directory. */
function hostUser(): string | undefined {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  return uid === undefined || gid === undefined ? undefined : `${uid}:${gid}`;
}

/**
 * Creates a sandbox on this host's Docker Engine: a container of `image` on an internal network
 * of its own, which reaches nothing, and beside it an egress proxy, the only way out, which lets
 * through the hosts of `networkPolicy` and logs what it refuses. Ports the sandbox listens on are
 * forwarded by the proxy and published on this host's loopback. Everything is removed again when
 * a step fails.
 */
export async function createDockerNetworkSandboxSession(
  options: DockerNetworkSandboxSessionCreateOptions,
): Promise<DockerNetworkSandboxSession> {
  const { sandboxId, workingDirectory } = checkedOptions(options);
  const cli = new DockerCli(options.binary);
  const names = namesOf(sandboxId, options);
  const forwards = forwardsOf(options.ports ?? []);
  await mkdir(names.stateDirectory, { recursive: true, mode: 0o700 });
  try {
    await writeNetworkPolicy(names.stateDirectory, options.networkPolicy ?? { mode: 'deny-all' });
    await writeFile(join(names.stateDirectory, BLOCKED_FILE), '', { flag: 'a' });
    const state: SandboxState = { workingDirectory, forwards };
    await writeFile(join(names.stateDirectory, STATE_FILE), `${JSON.stringify(state)}\n`);
    await startContainers(cli, { options, sandboxId, workingDirectory, names, forwards });
  } catch (error) {
    await removeSandbox(cli, { container: sandboxId, ...names }).catch(() => undefined);
    throw error;
  }
  return sessionOf(cli, { name: sandboxId, workingDirectory, resources: { ...names, forwards } });
}

/** The name and the working directory of a new sandbox; a `TypeError` for settings Docker refuses. */
function checkedOptions(options: DockerNetworkSandboxSessionCreateOptions): {
  sandboxId: string;
  workingDirectory: string;
} {
  const sandboxId = options.sandboxId ?? `ai-sdk-docker-${randomBytes(6).toString('hex')}`;
  checkSandboxId(sandboxId);
  checkMounts(options.mounts ?? []);
  assertEnvNames(Object.keys(options.env ?? {}));
  const workingDirectory = options.workingDirectory ?? '/workspace';
  if (!workingDirectory.startsWith('/')) {
    throw new TypeError(
      `\`workingDirectory\` must be an absolute path; got ${JSON.stringify(workingDirectory)}.`,
    );
  }
  return { sandboxId, workingDirectory };
}

/** The network, the proxy on it and on the default network, then the sandbox. */
async function startContainers(
  cli: DockerCli,
  {
    options,
    sandboxId,
    workingDirectory,
    names,
    forwards,
  }: {
    options: DockerNetworkSandboxSessionCreateOptions;
    sandboxId: string;
    workingDirectory: string;
    names: ReturnType<typeof namesOf>;
    forwards: PortForward[];
  },
): Promise<void> {
  const { abortSignal } = options;
  const label = `${LABEL}=${sandboxId}`;
  await cli.check(['network', 'create', '--internal', '--label', label, names.network], {
    abortSignal,
  });
  const proxy = proxyRunArgs({
    name: names.proxy,
    stateDirectory: names.stateDirectory,
    script: PROXY_SOURCE,
    forwards,
    user: hostUser(),
    image: options.proxyImage ?? options.image,
  });
  await cli.check(proxy, { abortSignal, unbounded: true });
  await cli.check(['network', 'connect', '--alias', PROXY_ALIAS, names.network, names.proxy], {
    abortSignal,
  });
  const sandbox = sandboxRunArgs({
    name: sandboxId,
    network: names.network,
    image: options.image,
    mounts: options.mounts ?? [],
    limits: options.limits,
    workingDirectory,
    user: options.user,
    env: options.env ?? {},
  });
  await cli.check(sandbox, { abortSignal, unbounded: true });
}

/**
 * Finds a sandbox created earlier, by its name, and starts it and its proxy again if they were
 * stopped: after `stop()`, or a restart of this host.
 *
 * @throws {DockerSandboxNotFoundError} when the sandbox, its proxy or its state is gone.
 */
export async function resumeDockerNetworkSandboxSession(
  options: DockerNetworkSandboxSessionResumeOptions,
): Promise<DockerNetworkSandboxSession> {
  const { sandboxId, abortSignal } = options;
  checkSandboxId(sandboxId);
  const cli = new DockerCli(options.binary);
  const names = namesOf(sandboxId, options);
  let state: SandboxState;
  try {
    state = JSON.parse(
      await readFile(join(names.stateDirectory, STATE_FILE), 'utf8'),
    ) as SandboxState;
  } catch {
    throw new DockerSandboxNotFoundError(sandboxId);
  }
  const started = await cli.run(['start', names.proxy, sandboxId], { abortSignal });
  if (started.exitCode !== 0) throw new DockerSandboxNotFoundError(sandboxId);
  return sessionOf(cli, {
    name: sandboxId,
    workingDirectory: state.workingDirectory,
    resources: { ...names, forwards: state.forwards },
  });
}

function sessionOf(
  cli: DockerCli,
  {
    name,
    workingDirectory,
    resources,
  }: { name: string; workingDirectory: string; resources: DockerSandboxResources },
): DockerNetworkSandboxSession {
  return new DockerNetworkSandboxSession(
    { cli, name, workingDirectory, processes: new Set() },
    resources,
  );
}
