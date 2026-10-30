import type { AddressInfo } from 'node:net';

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentServer } from './agent-server.js';

import { silentLogger } from '../common/logger.js';
import { createAgentServer } from './agent-server.js';

describe('the agent of a machine booted ahead of a sandbox', () => {
  const agents: AgentServer[] = [];
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(agents.splice(0).map((agent) => agent.close()));
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  /** An agent listening on the loopback, which powers off with `powerOff` after `afterMs`. */
  async function agentOf(powerOff: () => void, afterMs: number): Promise<string> {
    const root = mkdtempSync(join(tmpdir(), 'gce-agent-'));
    roots.push(root);
    const agent = createAgentServer({
      token: 'token-of-the-machine',
      user: userInfo().username,
      home: root,
      workingDirectory: root,
      path: process.env['PATH'] ?? '/usr/bin:/bin',
      stateDirectory: join(root, 'state'),
      configureDocker: false,
      idlePowerOff: { afterMs, runDirectory: join(root, 'run'), powerOff, uptimeMs: () => 0 },
      logger: silentLogger,
    });
    agents.push(agent);
    await new Promise<void>((resolve) => agent.server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(agent.server.address() as AddressInfo).port}`;
  }

  it('powers it off unless the service configures it first, for the sandbox that takes it', async () => {
    const idle = vi.fn();
    const taken = vi.fn();
    await agentOf(idle, 300);
    const url = await agentOf(taken, 300);

    const response = await fetch(`${url}/v1/config`, {
      method: 'PUT',
      headers: { 'x-ai-sdk-sandbox-agent-token': 'token-of-the-machine' },
      body: JSON.stringify({ proxy: 'http://10.8.16.2:3128', baseUrls: {} }),
    });
    expect(response.status).toBe(200);
    await sleep(600);

    expect(idle).toHaveBeenCalledOnce();
    expect(taken).not.toHaveBeenCalled();
  });

  it('is not stopped from powering off by a call without its token', async () => {
    const powerOff = vi.fn();
    const url = await agentOf(powerOff, 300);

    const response = await fetch(`${url}/v1/config`, {
      method: 'PUT',
      body: JSON.stringify({ proxy: 'http://10.8.16.2:3128', baseUrls: {} }),
    });
    expect(response.status).toBe(401);
    await sleep(600);

    expect(powerOff).toHaveBeenCalledOnce();
  });
});
