import type { SbxCli } from './sbx-cli.js';
import type { SbxConnectionSettings } from './sbx-settings.js';

import { PROBE } from './sandbox-scripts.js';
import { SbxNetworkSandboxSession } from './sbx-network-sandbox-session.js';
import { SbxSandboxNotFoundError } from './sbx-sandbox-not-found-error.js';
import { assertEnvNames } from './sbx-sandbox-session.js';

const ENV_LINE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

/** Where a credential lives: `ANTHROPIC_API_KEY`, `GH_TOKEN`…, but not `MCP_SENTINEL_TOKEN_NAME`. */
const CREDENTIAL_NAME = /(?:API_KEY|TOKEN)$/;

/** A credential Docker Sandboxes leaves for its own proxy to fill in. */
const isProxyManaged = (variable: string, value: string): boolean =>
  CREDENTIAL_NAME.test(variable) &&
  (value === 'proxy-managed' || value.includes('sbxproxymanaged'));

/** The sandboxes `sbx` knows of, by name and, for cloud ones, by `sbx_*` id too. */
export async function listSandboxes(cli: SbxCli, abortSignal?: AbortSignal): Promise<Set<string>> {
  const listed = JSON.parse(await cli.check(['ls', '--json'], { abortSignal })) as
    { id?: string; name?: string }[] | { sandboxes?: { id?: string; name?: string }[] };
  const sandboxes = Array.isArray(listed) ? listed : (listed.sandboxes ?? []);
  return new Set(
    sandboxes.flatMap(({ name, id }) => [name, id].filter((key) => key !== undefined)),
  );
}

/** Throws {@link SbxSandboxNotFoundError} unless a sandbox named `name` exists. */
export async function assertSandboxExists(
  cli: SbxCli,
  name: string,
  abortSignal?: AbortSignal,
): Promise<void> {
  if (!(await listSandboxes(cli, abortSignal)).has(name)) throw new SbxSandboxNotFoundError(name);
}

/**
 * Runs each of `setup` in the sandbox `name`, in order, stopping at the first failure. They run as
 * the sandbox user: `sbx --cloud exec` refuses `--user`, and the kits give that user `sudo`.
 */
export async function runSetup(
  cli: SbxCli,
  name: string,
  { setup, abortSignal }: { setup: readonly string[]; abortSignal?: AbortSignal },
): Promise<void> {
  for (const command of setup) {
    await cli.check(['exec', name, 'sh', '-c', command], { abortSignal });
  }
}

/**
 * A session on the existing sandbox `name`. Its working directory and its environment are read from
 * the live sandbox: they belong to its image, not to this package.
 */
export async function openSandbox(
  cli: SbxCli,
  name: string,
  settings: SbxConnectionSettings & { abortSignal?: AbortSignal },
): Promise<SbxNetworkSandboxSession> {
  const { clearEnv = [], keepProxyManagedEnv = false } = settings;
  assertEnvNames(clearEnv);
  const [workingDirectory = '', ...env] = (
    await cli.check(['exec', name, 'sh', '-c', PROBE], { abortSignal: settings.abortSignal })
  ).split('\n');
  const proxyManaged = keepProxyManagedEnv
    ? []
    : env.flatMap((line) => {
        const [, variable, value] = ENV_LINE.exec(line) ?? [];
        return variable !== undefined && value !== undefined && isProxyManaged(variable, value)
          ? [variable]
          : [];
      });
  return new SbxNetworkSandboxSession(
    {
      cli,
      name,
      workingDirectory: workingDirectory.trim(),
      processes: new Set(),
      clearEnv: [...new Set([...proxyManaged, ...clearEnv])],
    },
    settings.ports ?? [],
    settings.brokerCredentials ?? true,
  );
}
