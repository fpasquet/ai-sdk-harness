import { randomBytes } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';

import type { SbxNetworkSandboxSession } from '../src/index.js';

import { createSbxNetworkSandboxSession, resumeSbxNetworkSandboxSession } from '../src/index.js';

/**
 * Against Docker Sandboxes Cloud: needs a Docker Agentic Platform subscription and `sbx login`,
 * and runs only with SBX_E2E_CLOUD=1. The sandbox it creates is removed at the end.
 */
const binary = process.env.SBX_BIN ?? 'sbx';
const enabled = process.env.SBX_E2E_CLOUD === '1';

describe.skipIf(!enabled)('a Docker Sandboxes Cloud sandbox', () => {
  const sandboxId = `ai-sdk-sbx-e2e-cloud-${randomBytes(3).toString('hex')}`;
  let session: SbxNetworkSandboxSession;

  afterAll(async () => {
    await session?.destroy();
  });

  it('is created in the cloud', async () => {
    session = await createSbxNetworkSandboxSession({
      binary,
      cloud: true,
      sandboxId,
      ports: [4000],
      ttl: '30m',
      onTimeout: 'delete',
    });

    const { stdout } = await session.run({ command: 'echo "[$ANTHROPIC_API_KEY]"; whoami' });

    expect(session.cloud).toBe(true);
    expect(stdout.split('\n')[0]).toBe('[]');
  });

  it('reads and writes files', async () => {
    await session.writeTextFile({ path: 'notes/hello.txt', content: 'from the host' });

    expect(await session.readTextFile({ path: 'notes/hello.txt' })).toBe('from the host');
  });

  it('serves an exposed port at a public URL', async () => {
    const server = await session.spawn({
      command:
        "node -e \"require('http').createServer((q, r) => r.end('from the cloud')).listen(4000)\"",
    });
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const { url } = await session.getPortEndpoint({ port: 4000 });
    const response = await fetch(url);

    expect(url).toMatch(/^https:\/\//);
    expect(await response.text()).toBe('from the cloud');
    await server.kill();
  });

  it('is found again by its id', async () => {
    const resumed = await resumeSbxNetworkSandboxSession({ binary, cloud: true, sandboxId });

    expect(await resumed.readTextFile({ path: 'notes/hello.txt' })).toBe('from the host');
  });
});
