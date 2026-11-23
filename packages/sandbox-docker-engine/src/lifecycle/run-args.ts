import type { DockerLimits, DockerMount } from '../docker-settings.js';
import type { PortForward } from '../network/port-forwards.js';

import { SANDBOX_ALIAS } from '../network/port-forwards.js';

/** The alias of the egress proxy on the sandbox's network, and the port it listens on. */
export const PROXY_ALIAS = 'egress';
export const PROXY_PORT = 3128;
/** Where the proxy's container sees the sandbox's state directory. */
export const PROXY_STATE = '/egress';

/**
 * Where the proxy's container sees its script: an ES module, `.mts` when it is the TypeScript of
 * this repository's tests, which Node.js runs as it is.
 */
export const proxyScriptPath = (source: string): string =>
  source.endsWith('.ts') ? '/egress-proxy.mts' : '/egress-proxy.mjs';

/** The label every container and network of a sandbox carries, its value the sandbox's name. */
export const LABEL = 'ai-sdk-sandbox-docker-engine';

const DEFAULT_LIMITS = { memory: 4 * 1024 ** 3, cpus: 2, processes: 512 } as const;

/** What sends the sandbox's traffic to its proxy: its only way out. */
const PROXY_URL = `http://${PROXY_ALIAS}:${PROXY_PORT}`;
const PROXY_ENV: Record<string, string> = {
  HTTP_PROXY: PROXY_URL,
  HTTPS_PROXY: PROXY_URL,
  http_proxy: PROXY_URL,
  https_proxy: PROXY_URL,
  NO_PROXY: 'localhost,127.0.0.1',
  no_proxy: 'localhost,127.0.0.1',
  // Node.js's own `fetch` follows the variables above only when told to.
  NODE_USE_ENV_PROXY: '1',
};

/** No capability, nor any way of gaining one: what both containers of a sandbox run with. */
const UNPRIVILEGED = ['--cap-drop', 'ALL', '--security-opt', 'no-new-privileges'];

/** A name Docker takes for a container or a network. */
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;

/** Throws unless `name` can name the containers and the network of a sandbox. */
export function checkSandboxId(name: string): void {
  if (!NAME.test(name) || name.length > 56) {
    throw new TypeError(
      `A sandbox's name is letters, digits, \`_\`, \`.\` and \`-\`, 56 characters at most; got ${JSON.stringify(name)}.`,
    );
  }
}

/** Throws unless every mount goes from an absolute path to an absolute path. */
export function checkMounts(mounts: readonly DockerMount[]): void {
  for (const { from, to } of mounts) {
    if (
      !from.startsWith('/') ||
      !to.startsWith('/') ||
      [from, to].some((path) => path.includes(','))
    ) {
      throw new TypeError(
        `A mount goes from an absolute path of this host to an absolute path of the sandbox; got ${JSON.stringify({ from, to })}.`,
      );
    }
  }
}

/** `docker run` of the egress proxy: alone on the default network, its forwarded ports published. */
export function proxyRunArgs({
  name,
  stateDirectory,
  script,
  forwards,
  user,
  image,
}: {
  name: string;
  stateDirectory: string;
  script: string;
  forwards: readonly PortForward[];
  user: string | undefined;
  image: string;
}): string[] {
  return [
    'run',
    '--detach',
    // An init passes the stop signal on: the proxy stops at once, and starts again with the sandbox.
    '--init',
    '--name',
    name,
    '--label',
    `${LABEL}=${name}`,
    '--memory',
    String(256 * 1024 ** 2),
    '--cpus',
    '0.5',
    '--pids-limit',
    '64',
    ...(user === undefined ? [] : ['--user', user]),
    ...UNPRIVILEGED,
    '--read-only',
    '--env',
    `EGRESS_POLICY=${PROXY_STATE}/policy.json`,
    '--env',
    `EGRESS_LOG=${PROXY_STATE}/blocked.jsonl`,
    '--env',
    `EGRESS_PORT=${PROXY_PORT}`,
    '--env',
    `EGRESS_FORWARDS=${JSON.stringify(forwards)}`,
    ...forwards.flatMap(({ listen }) => ['--publish', `127.0.0.1::${listen}`]),
    '--mount',
    `type=bind,source=${stateDirectory},target=${PROXY_STATE}`,
    '--mount',
    `type=bind,source=${script},target=${proxyScriptPath(script)},readonly`,
    '--entrypoint',
    'node',
    image,
    proxyScriptPath(script),
  ];
}

/**
 * `docker run` of the sandbox: on its internal network alone, its traffic sent to the proxy, its
 * limits, no capability, and for files the image and its mounts. It waits, doing nothing: every
 * command runs in it through `docker exec`.
 */
export function sandboxRunArgs({
  name,
  network,
  image,
  mounts,
  limits = {},
  workingDirectory,
  user,
  env,
}: {
  name: string;
  network: string;
  image: string;
  mounts: readonly DockerMount[];
  limits?: DockerLimits;
  workingDirectory: string;
  user: string | undefined;
  env: Record<string, string>;
}): string[] {
  return [
    'run',
    '--detach',
    // An init first: the wait stops at the signal, without the 10 s of `docker stop`.
    '--init',
    '--name',
    name,
    '--label',
    `${LABEL}=${name}`,
    '--network',
    network,
    '--network-alias',
    SANDBOX_ALIAS,
    '--memory',
    String(limits.memory ?? DEFAULT_LIMITS.memory),
    '--cpus',
    String(limits.cpus ?? DEFAULT_LIMITS.cpus),
    '--pids-limit',
    String(limits.processes ?? DEFAULT_LIMITS.processes),
    ...(user === undefined ? [] : ['--user', user]),
    ...UNPRIVILEGED,
    // Values the sandbox's own variables: given on the command line, never a secret.
    ...Object.entries({ ...PROXY_ENV, ...env }).flatMap(([key, value]) => [
      '--env',
      `${key}=${value}`,
    ]),
    ...mounts.flatMap(({ from, to, readOnly }) => [
      '--mount',
      `type=bind,source=${from},target=${to}${readOnly === true ? ',readonly' : ''}`,
    ]),
    '--workdir',
    workingDirectory,
    '--entrypoint',
    'tail',
    image,
    '-f',
    '/dev/null',
  ];
}
