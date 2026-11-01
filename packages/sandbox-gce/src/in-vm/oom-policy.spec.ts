import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { silentLogger } from '../common/logger.js';
import { keepRunningOnOomKill, serviceOf } from './oom-policy.js';

describe('the OOM policy of the agent’s service', () => {
  let root: string;
  let cgroupFile: string;
  const dropIn = (): string =>
    join(root, 'run', 'ai-sdk-sandbox-agent.service.d', '50-ai-sdk-sandbox-oom-policy.conf');

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gce-oom-'));
    cgroupFile = join(root, 'cgroup');
    writeFileSync(cgroupFile, '0::/system.slice/ai-sdk-sandbox-agent.service\n');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('reads the service from the cgroup, v1 or v2, and none outside a service', () => {
    expect(serviceOf('0::/system.slice/ai-sdk-sandbox-agent.service\n')).toBe(
      'ai-sdk-sandbox-agent.service',
    );
    expect(
      serviceOf(
        '12:pids:/system.slice/agent.service\n1:name=systemd:/system.slice/agent.service\n',
      ),
    ).toBe('agent.service');
    expect(serviceOf('0::/user.slice/user-1000.slice/session-3.scope\n')).toBeUndefined();
    expect(serviceOf('0::/\n')).toBeUndefined();
  });

  it('keeps the service running when the OOM killer kills one of its commands', async () => {
    const reload = vi.fn(() => Promise.resolve());

    await keepRunningOnOomKill({
      cgroupFile,
      dropInRoot: join(root, 'run'),
      reload,
      logger: silentLogger,
    });

    // systemd's default, `stop`, sent SIGTERM to every command of the sandbox, and to the agent.
    expect(readFileSync(dropIn(), 'utf8')).toBe('[Service]\nOOMPolicy=continue\n');
    expect(reload).toHaveBeenCalledOnce();
  });

  it('reloads systemd only when the drop-in changes: an agent restarted in the same boot finds it', async () => {
    const reload = vi.fn(() => Promise.resolve());
    const settings = { cgroupFile, dropInRoot: join(root, 'run'), reload, logger: silentLogger };

    await keepRunningOnOomKill(settings);
    await keepRunningOnOomKill(settings);

    expect(reload).toHaveBeenCalledOnce();
  });

  it('leaves alone an agent that runs outside a service, or where the cgroup cannot be read', async () => {
    const reload = vi.fn(() => Promise.resolve());
    writeFileSync(cgroupFile, '0::/user.slice/user-1000.slice/session-3.scope\n');

    await keepRunningOnOomKill({
      cgroupFile,
      dropInRoot: join(root, 'run'),
      reload,
      logger: silentLogger,
    });
    await keepRunningOnOomKill({
      cgroupFile: join(root, 'missing'),
      dropInRoot: join(root, 'run'),
      reload,
      logger: silentLogger,
    });

    expect(existsSync(join(root, 'run'))).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it('never fails the agent’s start: a reload that fails is logged', async () => {
    const warn = vi.fn();

    await keepRunningOnOomKill({
      cgroupFile,
      dropInRoot: join(root, 'run'),
      reload: () => Promise.reject(new Error('Access denied')),
      logger: { ...silentLogger, warn },
    });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Access denied'));
  });
});
