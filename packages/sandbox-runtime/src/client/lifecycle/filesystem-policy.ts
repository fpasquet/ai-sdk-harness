import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, relative } from 'node:path';

import type { SrtFilesystem } from '../transport/srt-runtime.js';
import type { SandboxLayout, SandboxRecord } from './sandbox-directory.js';

import { SUPERVISOR_DIRECTORY } from '../session/supervisor-host.js';
import { srtRoot } from '../utils/package-location.js';

/** This host, as far as a sandbox depends on it. */
export interface HostEnvironment {
  /** The host user's home directory. */
  readonly home: string;
  /** The Node.js binary the supervisor runs with. */
  readonly node: string;
  /** The host's `PATH`. */
  readonly path: string;
  /** The host's locale, which the sandbox keeps. */
  readonly lang?: string;
  /** The host user's name. */
  readonly user?: string;
  /** srt's own package, whose helpers (`apply-seccomp`, the JVM proxy agent) run in the sandbox. */
  readonly srt: string;
}

export const currentHost = (env: NodeJS.ProcessEnv = process.env): HostEnvironment => ({
  home: homedir(),
  node: process.execPath,
  path: env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
  srt: srtRoot(),
  ...(env.LANG !== undefined && { lang: env.LANG }),
  ...(env.USER !== undefined && { user: env.USER }),
});

const isInside = (path: string, parent: string): boolean => {
  const rest = relative(parent, path);
  return rest === '' || (!rest.startsWith('..') && !rest.startsWith('/'));
};

/** The installation of Node.js the supervisor runs from: `<prefix>/bin/node`. */
function nodePrefix(node: string): string {
  let binary = node;
  try {
    binary = realpathSync(node);
  } catch {
    // A binary that cannot be resolved is taken as given.
  }
  return dirname(dirname(binary));
}

/** Where `npm install --global` installs in the sandbox: in its own home, which it may write. */
const globalPrefix = (layout: SandboxLayout): string => join(layout.home, '.local');

/**
 * `PATH` in the sandbox: the host's, after the sandbox's own global installs, then the directory
 * of the supervisor's Node.js.
 */
export function sandboxPath(layout: SandboxLayout, host: HostEnvironment): string {
  const entries = host.path.split(delimiter).filter((entry) => entry !== '');
  const first = [join(globalPrefix(layout), 'bin'), dirname(host.node)];
  return [...new Set([...first, ...entries])].join(delimiter);
}

/**
 * The environment srt starts the supervisor with, which every process of the sandbox inherits:
 * nothing of this process's own but its locale, its user name and its `PATH`. A global npm install
 * goes to the sandbox's home, the one place it may write a tool to, and corepack keeps to the
 * releases it knows.
 */
export function environmentOf(
  layout: SandboxLayout,
  host: HostEnvironment,
): Record<string, string> {
  return {
    PATH: sandboxPath(layout, host),
    HOME: layout.home,
    TMPDIR: layout.tmpdir,
    NPM_CONFIG_PREFIX: globalPrefix(layout),
    // Corepack's latest pnpm (12) locks its store under /tmp, which srt keeps read-only: its
    // last known good release does not.
    COREPACK_DEFAULT_TO_LATEST: '0',
    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    LANG: host.lang ?? 'C.UTF-8',
    ...(host.user !== undefined && { USER: host.user }),
    SHELL: '/bin/sh',
  };
}

/**
 * What the sandbox may read and write, in srt's terms.
 *
 * - **Read**: everything, but the host user's home when `hideHome` is set (the default) and the
 *   paths of `denyRead`. Inside the home, the sandbox still reads its own directory, the workspaces,
 *   Node.js, srt's helpers, the directories of the `PATH` and `allowRead`.
 * - **Write**: its own `sandbox/` directory and the workspace, plus `allowWrite`, less `denyWrite`.
 *   Its settings and its supervisor, beside `sandbox/`, are never writable.
 */
export function filesystemOf(
  layout: SandboxLayout,
  record: SandboxRecord,
  host: HostEnvironment = currentHost(),
): SrtFilesystem {
  const workspaces = [
    ...(record.workspace === undefined ? [] : [record.workspace]),
    ...record.readOnlyWorkspaces,
  ];
  const needed = [
    layout.writable,
    join(layout.base, SUPERVISOR_DIRECTORY),
    ...workspaces,
    nodePrefix(host.node),
    host.srt,
    ...sandboxPath(layout, host).split(delimiter),
  ];
  const hidden = record.hideHome ? [host.home] : [];
  return {
    denyRead: [...hidden, ...record.denyRead],
    allowRead: [
      ...new Set([
        ...needed.filter((path) => hidden.some((home) => isInside(path, home))),
        ...record.allowRead,
      ]),
    ],
    allowWrite: [
      layout.writable,
      ...(record.workspace === undefined ? [] : [record.workspace]),
      ...record.allowWrite,
    ],
    denyWrite: [...record.denyWrite],
  };
}
