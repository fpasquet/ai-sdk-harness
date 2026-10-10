import type { MicrosandboxCreationSettings } from '../microsandbox-settings.js';
import type { SandboxSpec } from '../transport/microsandbox-runtime.js';

import { freeLoopbackPort } from '../network/free-loopback-port.js';
import { toNetworkPolicy } from '../network/network-policy.js';

/** The image a sandbox boots from by default: Node.js for the harness, git and curl for the agent. */
export const DEFAULT_IMAGE = 'node:24';
/**
 * The user commands run as in the default image: its unprivileged one. Claude Code refuses to
 * skip its permission prompts as root.
 */
export const DEFAULT_USER = 'node';
export const DEFAULT_CPUS = 2;
export const DEFAULT_MEMORY = 2048;

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

/** The spec of a new sandbox: the settings, with a free loopback port picked for each port. */
export async function sandboxSpec(settings: MicrosandboxCreationSettings): Promise<SandboxSpec> {
  const { ports = [], workspace, networkPolicy } = settings;
  assertPorts(ports);
  // Another image has users of its own: its default one runs the commands.
  const user = settings.user ?? (settings.image === undefined ? DEFAULT_USER : undefined);
  return {
    cpus: settings.cpus ?? DEFAULT_CPUS,
    memory: settings.memory ?? DEFAULT_MEMORY,
    ports: await Promise.all(
      ports.map(async (guestPort) => ({ guestPort, hostPort: await freeLoopbackPort() })),
    ),
    user,
    workspace,
    networkPolicy: networkPolicy === undefined ? undefined : toNetworkPolicy(networkPolicy),
  };
}
