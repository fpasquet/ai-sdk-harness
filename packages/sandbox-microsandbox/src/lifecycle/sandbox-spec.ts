import type { HarnessV1NetworkPolicy } from '@ai-sdk/harness';

import { isAbsolute, resolve } from 'node:path';

import type { MicrosandboxCreationSettings } from '../microsandbox-settings.js';
import type { SandboxSpec } from '../transport/microsandbox-runtime.js';

import { freeLoopbackPort } from '../network/free-loopback-port.js';
import { toNetworkPolicy } from '../network/network-policy.js';
import { WORKSPACE } from '../transport/sandbox-scripts.js';

/** The image a sandbox boots from by default: Node.js for the harness, git and curl for the agent. */
export const DEFAULT_IMAGE = 'node:24';
/**
 * The user commands run as in the default image: its unprivileged one. Claude Code refuses to
 * skip its permission prompts as root.
 */
export const DEFAULT_USER = 'node';
export const DEFAULT_CPUS = 2;
export const DEFAULT_MEMORY = 2048;
/** No setuid way to root for the commands; a Docker daemon needs `default`. */
export const DEFAULT_SECURITY = 'restricted';
/** microsandbox's own default in its multi-tenant profile: around 128 MiB of this host at most. */
export const DEFAULT_MAX_TCP_CONNECTIONS = 1024;
/** A Docker daemon and its containers want more than a harness alone. */
export const DOCKER_MEMORY = 4096;
/** In MiB: room for a few images and their layers. The disk is sparse: only what is used is taken. */
export const DEFAULT_DOCKER_DISK_SIZE = 10_240;
/**
 * Where `docker pull` goes for Docker Hub's images, which a `custom` policy is given: the registry,
 * its token service, and the two CDNs its layers are served from.
 */
export const DOCKER_HUB_HOSTS = [
  'registry-1.docker.io',
  'auth.docker.io',
  'production.cloudflare.docker.com',
  'production.cloudfront.docker.com',
];

/** What microsandbox accepts as a name: a letter or a digit, then letters, digits, `.`, `_`, `-`. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_NAME_BYTES = 128;

export function assertSandboxName(name: string): void {
  if (!NAME.test(name) || Buffer.byteLength(name) > MAX_NAME_BYTES) {
    throw new Error(
      `"${name}" is not a valid sandbox id: use letters, digits, periods, underscores and ` +
        `hyphens, starting with a letter or a digit, ${MAX_NAME_BYTES} characters at most.`,
    );
  }
}

function assertPorts(ports: readonly number[]): void {
  for (const port of ports) {
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error(`${port} is not a TCP port: use an integer from 1 to 65535.`);
    }
  }
  if (new Set(ports).size !== ports.length) {
    throw new Error(`\`ports\` lists a port twice: [${ports.join(', ')}].`);
  }
}

/** Mounted at their own path: never over the whole filesystem, nor over the working directory. */
function assertReadOnlyWorkspaces(paths: readonly string[]): void {
  for (const path of paths) {
    // Without trailing slashes nor `..`: what the path stands for.
    const resolved = resolve(path);
    const overlaps =
      resolved === WORKSPACE ||
      resolved.startsWith(`${WORKSPACE}/`) ||
      WORKSPACE.startsWith(`${resolved}/`);
    if (!isAbsolute(path) || resolved === '/' || overlaps) {
      throw new Error(
        `\`readOnlyWorkspaces\`: "${path}" must be an absolute path of this host, neither \`/\` ` +
          `nor one that overlaps ${WORKSPACE}, where it is mounted read-only at the same path.`,
      );
    }
  }
}

function assertPositiveInteger(name: string, value: number | undefined): void {
  if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
    throw new Error(`\`${name}\` must be a positive integer, not ${value}.`);
  }
}

/** The Docker disk of `settings`, when the sandbox runs Docker. */
function dockerOf(settings: MicrosandboxCreationSettings): undefined | { diskSize: number } {
  const { docker = false } = settings;
  if (docker === false) return undefined;
  const diskSize = (docker === true ? undefined : docker.diskSize) ?? DEFAULT_DOCKER_DISK_SIZE;
  assertPositiveInteger('docker.diskSize', diskSize);
  if (settings.security === 'restricted') {
    throw new Error(
      "`docker` needs root semantics in the sandbox: leave `security` out, or set it to 'default'.",
    );
  }
  return { diskSize };
}

/** `policy`, with Docker Hub's hosts on top of a `custom` one's when the sandbox runs Docker. */
function withDockerHub(
  policy: HarnessV1NetworkPolicy | undefined,
  docker: boolean,
): HarnessV1NetworkPolicy | undefined {
  if (!docker || policy?.mode !== 'custom') return policy;
  return { ...policy, allowedHosts: [...(policy.allowedHosts ?? []), ...DOCKER_HUB_HOSTS] };
}

/** Fails, before anything is created, on settings microsandbox would refuse or misread. */
function assertSettings(settings: MicrosandboxCreationSettings): void {
  assertPorts(settings.ports ?? []);
  assertReadOnlyWorkspaces(settings.readOnlyWorkspaces ?? []);
  assertPositiveInteger('maxDuration', settings.maxDuration);
  assertPositiveInteger('idleTimeout', settings.idleTimeout);
  assertPositiveInteger('maxTcpConnections', settings.maxTcpConnections);
}

/** What the sandbox is given of this host, and how it is fenced: more of both with Docker. */
function resourcesOf(settings: MicrosandboxCreationSettings, docker: boolean) {
  return {
    cpus: settings.cpus ?? DEFAULT_CPUS,
    memory: settings.memory ?? (docker ? DOCKER_MEMORY : DEFAULT_MEMORY),
    security: settings.security ?? (docker ? 'default' : DEFAULT_SECURITY),
    maxTcpConnections: settings.maxTcpConnections ?? DEFAULT_MAX_TCP_CONNECTIONS,
  };
}

/** The spec of a new sandbox: the settings, with a free loopback port picked for each port. */
export async function sandboxSpec(settings: MicrosandboxCreationSettings): Promise<SandboxSpec> {
  assertSettings(settings);
  const { ports = [], readOnlyWorkspaces = [] } = settings;
  const docker = dockerOf(settings);
  const policy = withDockerHub(settings.networkPolicy, docker !== undefined);
  // Another image has users of its own: its default one runs the commands.
  const user = settings.user ?? (settings.image === undefined ? DEFAULT_USER : undefined);
  return {
    ...resourcesOf(settings, docker !== undefined),
    ports: await Promise.all(
      ports.map(async (guestPort) => ({ guestPort, hostPort: await freeLoopbackPort() })),
    ),
    user,
    workspace: settings.workspace,
    readOnlyWorkspaces: readOnlyWorkspaces.map((path) => resolve(path)),
    networkPolicy: policy === undefined ? undefined : toNetworkPolicy(policy),
    docker,
    maxDuration: settings.maxDuration,
    idleTimeout: settings.idleTimeout,
  };
}
