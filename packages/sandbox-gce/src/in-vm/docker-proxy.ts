import { execFile } from 'node:child_process';
import { chownSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import type { AgentConfig } from '../protocol/agent.js';
import type { CommandUser } from './processes.js';

import { noProxy } from './environment.js';

const run = promisify(execFile);

/** The systemd drop-in giving the Docker daemon the proxy: what it pulls images through. */
const DAEMON_DROP_IN = '/etc/systemd/system/docker.service.d/ai-sdk-sandbox-proxy.conf';

/** Writes `content` to `path` unless it holds it already: whether it changed. */
function writeIfChanged(path: string, content: string): boolean {
  if (existsSync(path) && readFileSync(path, 'utf8') === content) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return true;
}

/**
 * Points Docker at the egress proxy, when the machine has it: the daemon, which pulls the images,
 * and the client of the sandbox's user, which passes the proxy on to the containers it starts and
 * the builds it runs. The machine has no other way out. The daemon is restarted when its proxy
 * changed, which only happens before the first command of a sandbox.
 */
export async function configureDocker(
  config: AgentConfig,
  { home, user }: { home: string; user?: CommandUser },
): Promise<void> {
  if (!existsSync('/usr/bin/dockerd')) return;
  const origin = new URL(config.proxy).origin;
  const excluded = noProxy(config);
  const changed = writeIfChanged(
    DAEMON_DROP_IN,
    [
      '[Service]',
      `Environment="HTTP_PROXY=${origin}" "HTTPS_PROXY=${origin}" "NO_PROXY=${excluded}"`,
      '',
    ].join('\n'),
  );
  if (changed) {
    await run('systemctl', ['daemon-reload']);
    await run('systemctl', ['restart', 'docker']);
  }
  const clientConfig = join(home, '.docker', 'config.json');
  let current: Record<string, unknown> = {};
  try {
    current = JSON.parse(readFileSync(clientConfig, 'utf8')) as Record<string, unknown>;
  } catch {
    // None yet, or not JSON: it is made anew.
  }
  const proxies = { default: { httpProxy: origin, httpsProxy: origin, noProxy: excluded } };
  if (writeIfChanged(clientConfig, `${JSON.stringify({ ...current, proxies }, null, 2)}\n`)) {
    if (user !== undefined) {
      chownSync(dirname(clientConfig), user.uid, user.gid);
      chownSync(clientConfig, user.uid, user.gid);
    }
  }
}
