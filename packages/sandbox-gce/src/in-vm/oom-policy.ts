import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { Logger } from '../common/logger.js';

const run = promisify(execFile);

/** What the drop-in holds: systemd leaves the service running when the OOM killer kills in it. */
const DROP_IN = '[Service]\nOOMPolicy=continue\n';

/** The drop-in's name, beside any of the image's own. */
const DROP_IN_FILE = '50-ai-sdk-sandbox-oom-policy.conf';

/** Where the agent keeps its service running when one of its commands runs out of memory. */
export interface OomPolicySettings {
  /** The agent's cgroup, which names its service: `/proc/self/cgroup` without it. Tests only. */
  cgroupFile?: string;
  /** Where runtime drop-ins go, emptied at each boot: `/run/systemd/system` without it. Tests only. */
  dropInRoot?: string;
  /** Has systemd read the drop-in: `systemctl daemon-reload` without it. Tests only. */
  reload?: () => Promise<void>;
  logger: Logger;
}

/** The systemd service of a process, from its `/proc/<pid>/cgroup`: `undefined` outside one. */
export function serviceOf(cgroup: string): string | undefined {
  for (const line of cgroup.split('\n')) {
    // `<id>:<controllers>:<path>`, the path last: `0::/system.slice/<name>.service` on cgroup v2.
    const unit = line.split(':').slice(2).join(':').split('/').at(-1);
    if (unit !== undefined && /^[\w@.\\-]+\.service$/.test(unit)) return unit;
  }
  return undefined;
}

/**
 * Keeps the agent's systemd service running when the kernel's OOM killer kills one of its
 * processes. The commands run in the service's cgroup, and systemd stops a service whose process
 * the OOM killer killed (`OOMPolicy=stop`, its default): one command out of memory sent `SIGTERM`
 * to every other command of the sandbox, which exited with 143, and to the agent, restarted by
 * `Restart=always`. A runtime drop-in sets `OOMPolicy=continue` on the running service, whatever
 * unit the image has: only the killed process goes, its command exiting with 137. Never fails: the
 * agent runs without it, as before.
 */
export async function keepRunningOnOomKill({
  cgroupFile = '/proc/self/cgroup',
  dropInRoot = '/run/systemd/system',
  reload = async () => void (await run('systemctl', ['daemon-reload'])),
  logger,
}: OomPolicySettings): Promise<void> {
  let service: string | undefined;
  try {
    service = serviceOf(readFileSync(cgroupFile, 'utf8'));
  } catch {
    // No cgroup to read: not on Linux.
  }
  if (service === undefined) return;
  const file = join(dropInRoot, `${service}.d`, DROP_IN_FILE);
  try {
    if (existsSync(file) && readFileSync(file, 'utf8') === DROP_IN) return;
    mkdirSync(join(dropInRoot, `${service}.d`), { recursive: true });
    writeFileSync(file, DROP_IN);
    await reload();
  } catch (error) {
    logger.warn(
      `${service} could not be kept running on an OOM kill: one command out of memory stops every command. ${String(error)}`,
    );
  }
}
