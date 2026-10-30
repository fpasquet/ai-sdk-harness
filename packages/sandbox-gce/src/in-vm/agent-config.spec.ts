import type { AddressInfo } from 'node:net';

import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { silentLogger } from '../common/logger.js';
import { agentSettings } from './agent-config.js';

describe('the settings of the agent', () => {
  let server: ReturnType<typeof createServer>;
  let root: string;
  let metadata: Record<string, string>;
  let reads: string[];
  let env: Record<string, string>;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'gce-agent-'));
    reads = [];
    metadata = { 'ai-sdk-sandbox-agent-token': 'token-of-the-machine' };
    server = createServer((request, response) => {
      const key = (request.url ?? '').split('/').at(-1) ?? '';
      reads.push(key);
      const value = metadata[key];
      response.writeHead(value === undefined ? 404 : 200).end(value ?? '');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    env = {
      METADATA_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/attributes/`,
      SANDBOX_USER: userInfo().username,
      SANDBOX_HOME: join(root, 'home'),
      SANDBOX_WORKDIR: join(root, 'workspace'),
      SANDBOX_RUN_DIR: join(root, 'run'),
    };
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  });

  /** As root, which the agent of a sandbox image runs as. */
  const asRoot = (): void => void vi.spyOn(process, 'getuid').mockReturnValue(0);

  it('powers its machine off when the metadata says so, as root only', async () => {
    metadata['ai-sdk-sandbox-idle-poweroff-minutes'] = '16';
    asRoot();

    const settings = await agentSettings(env, silentLogger);

    expect(settings.token).toBe('token-of-the-machine');
    expect(settings.idlePowerOff).toEqual({
      afterMs: 16 * 60_000,
      runDirectory: join(root, 'run'),
    });
    vi.restoreAllMocks();
    expect((await agentSettings(env, silentLogger)).idlePowerOff).toBeUndefined();
  });

  it('never powers it off without the key, or with one that is no number of minutes', async () => {
    asRoot();
    expect((await agentSettings(env, silentLogger)).idlePowerOff).toBeUndefined();

    metadata['ai-sdk-sandbox-idle-poweroff-minutes'] = 'soon';
    const warn = vi.fn();
    expect((await agentSettings(env, { ...silentLogger, warn })).idlePowerOff).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('is not a positive integer'));
  });

  it('reads nothing of the metadata with a token of its environment', async () => {
    metadata['ai-sdk-sandbox-idle-poweroff-minutes'] = '16';
    asRoot();

    const settings = await agentSettings({ ...env, SANDBOX_AGENT_TOKEN: 'given' }, silentLogger);

    expect(settings.token).toBe('given');
    expect(settings.idlePowerOff).toBeUndefined();
    expect(reads).toEqual([]);
  });
});
