import type { Experimental_SandboxSession } from 'ai';

import { randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ApprovalPolicy } from '../policy/approval-policy.js';

import { POLICY_NAME } from '../definitions/sandbox.js';

/** Where the policies live in the sandbox: root's, out of the agent's reach. */
export const SANDBOX_POLICY_DIR = '/etc/claude-code/ai-sdk-harness';
/** The fragment of Claude Code's managed settings that runs the hook: read whatever else is set. */
const MANAGED_SETTINGS = '/etc/claude-code/managed-settings.d/ai-sdk-harness-approval.json';
/** The compiled package, the hook and what it imports: `dist/` from here, built or not. */
const DIST = fileURLToPath(new URL('../../dist/', import.meta.url));
const HOOK = `${SANDBOX_POLICY_DIR}/hook/sandbox/hook-main.js`;

/** What the installation needs of a sandbox: a command, and a file written. */
export type PolicySandbox = Pick<Experimental_SandboxSession, 'run' | 'writeTextFile'>;

const quote = (value: string) => `'${value.replaceAll("'", String.raw`'\''`)}'`;

/** The compiled modules of the package, by their path under `dist/`. */
async function hookModules(): Promise<Map<string, string>> {
  const entries = await readdir(DIST, { recursive: true, withFileTypes: true }).catch(() => []);
  const modules = new Map<string, string>();
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
    const path = join(entry.parentPath, entry.name);
    modules.set(relative(DIST, path), await readFile(path, 'utf8'));
  }
  if (!modules.has('sandbox/hook-main.js')) {
    throw new Error(`The hook is not built: run the build of ai-sdk-harness-approval (${DIST}).`);
  }
  return modules;
}

/**
 * Installs approval policies in a sandbox, under their names, for the Claude Code agents that
 * `policy.claudeCodeSandbox(name)` set up: a `PreToolUse` hook, in Claude Code's managed settings,
 * decides each command and edit before it runs. Root's files, which the agent can neither change
 * nor remove; installing again replaces them all.
 *
 * Needs root in the sandbox, or `sudo` without a password (Docker Sandboxes have it), and Node.js
 * (the harness installs it). Run it once the sandbox is open, before the sessions start.
 */
export async function installClaudeCodePolicies(
  sandbox: PolicySandbox,
  policies: Readonly<Record<string, ApprovalPolicy>>,
): Promise<void> {
  for (const [name, policy] of Object.entries(policies)) {
    if (!POLICY_NAME.test(name))
      throw new TypeError(`Invalid policy name: ${JSON.stringify(name)}.`);
    // Refuses a policy the sandbox cannot hold an agent to.
    policy.claudeCodeSandbox(name);
  }
  const staging = `/tmp/ai-sdk-harness-approval-${randomBytes(6).toString('hex')}`;
  const files = new Map<string, string>([
    ['hook/package.json', JSON.stringify({ type: 'module' })],
    ...[...(await hookModules())].map(([path, source]) => [`hook/${path}`, source] as const),
    ...Object.entries(policies).map(
      ([name, policy]) => [`policies/${name}.json`, JSON.stringify(policy.settings)] as const,
    ),
    [
      'managed-settings.json',
      JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: `node ${HOOK}` }] }],
        },
      }),
    ],
  ]);
  for (const [path, content] of files) {
    await sandbox.writeTextFile({ path: `${staging}/${path}`, content });
  }
  const script = [
    'set -e',
    'if [ "$(id -u)" = 0 ]; then as_root=""; else as_root="sudo -n"; fi',
    `$as_root rm -rf ${quote(SANDBOX_POLICY_DIR)}`,
    `$as_root mkdir -p ${quote(SANDBOX_POLICY_DIR)} /etc/claude-code/managed-settings.d`,
    `$as_root cp -R ${quote(`${staging}/hook`)} ${quote(`${staging}/policies`)} ${quote(SANDBOX_POLICY_DIR)}/`,
    `$as_root cp ${quote(`${staging}/managed-settings.json`)} ${quote(MANAGED_SETTINGS)}`,
    `$as_root chown -R root:root ${quote(SANDBOX_POLICY_DIR)} ${quote(MANAGED_SETTINGS)}`,
    `$as_root chmod -R a+rX,go-w ${quote(SANDBOX_POLICY_DIR)} ${quote(MANAGED_SETTINGS)}`,
  ].join('\n');
  const installed = await sandbox.run({ command: script });
  await sandbox.run({ command: `rm -rf ${quote(staging)}` });
  if (installed.exitCode !== 0) {
    throw new Error(
      `The approval policies could not be installed in the sandbox: it needs root, or sudo without a password. ${installed.stderr.trim()}`,
    );
  }
}
