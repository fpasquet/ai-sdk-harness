import type { HarnessV1SandboxTemplate } from '@ai-sdk/harness';

import { randomBytes } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';

import type { GkeAuth, GkeNetworkSandboxSession } from '../src/index.js';

import { templateId } from '../src/client/lifecycle/sandbox-template.js';
import { identityToken } from '../src/client/transport/identity-token.js';
import { SandboxServiceClient } from '../src/client/transport/sandbox-service-client.js';
import { createGkeNetworkSandboxSession, resumeGkeNetworkSandboxSession } from '../src/index.js';

/**
 * Against a sandbox service deployed in a GKE cluster: set GKE_SANDBOX_URL to its URL, as this
 * machine reaches it (`kubectl port-forward service/ai-sdk-sandbox 8080:80`, say), and
 * GKE_SANDBOX_SERVICE_TOKEN to its token. Every sandbox and template it makes is removed at the
 * end.
 */
const url = process.env['GKE_SANDBOX_URL'];
const auth = (process.env['GKE_SANDBOX_AUTH'] ?? 'none') as GkeAuth;
const run = randomBytes(3).toString('hex');
const sessions: GkeNetworkSandboxSession[] = [];
const template: HarnessV1SandboxTemplate = {
  identity: `e2e-${run}`,
  prepare: async ({ session }) => {
    const { exitCode } = await session.run({ command: 'echo baked > "$HOME/baked.txt"' });
    expect(exitCode).toBe(0);
  },
};

describe.skipIf(url === undefined)('a sandbox on GKE', () => {
  const options = {
    url: url ?? '',
    auth,
    allowedHosts: ['registry.npmjs.org'],
    ports: [4000],
    serviceToken: process.env['GKE_SANDBOX_SERVICE_TOKEN'] ?? '',
  };
  let session: GkeNetworkSandboxSession;

  afterAll(async () => {
    await Promise.all(sessions.map((created) => created.destroy().catch(() => undefined)));
    const client = new SandboxServiceClient(options.url, {
      token: identityToken(auth, options.url),
      serviceToken: options.serviceToken,
    });
    await client.deleteTemplate(templateId({ template, setup: [] })).catch(() => undefined);
  });

  it('runs a pod of its own, its commands never as root', async () => {
    session = await createGkeNetworkSandboxSession({ ...options, sandboxId: `e2e-${run}` });
    sessions.push(session);

    const { stdout, exitCode } = await session.run({ command: 'id -u; pwd' });

    expect(exitCode).toBe(0);
    expect(stdout).not.toMatch(/^0\n/);
    expect(stdout).toContain(`\n${session.defaultWorkingDirectory}\n`);
  });

  it('reaches the allowed hosts through the proxy, and nothing else', async () => {
    const { stdout } = await session.run({
      command:
        'curl -sS -o /dev/null -w "%{http_code}\\n" https://registry.npmjs.org/ai; ' +
        'curl -sS -o /dev/null -w "%{http_code}\\n" https://example.com/ || true; ' +
        'curl -sS --noproxy "*" --max-time 5 https://104.16.0.1/ >/dev/null 2>&1 || echo direct-refused; ' +
        'curl -sS --noproxy "*" --max-time 5 -H "Metadata-Flavor: Google" http://169.254.169.254/computeMetadata/v1/instance/service-accounts/ || echo no-account; ' +
        'getent hosts kubernetes.default.svc.cluster.local || echo no-resolver',
    });

    expect(stdout).toMatch(/^200\n(403|000)\n/);
    expect(stdout).toContain('direct-refused');
    expect(stdout).toContain('no-resolver');
    expect(stdout).not.toContain('default/');
  });

  it('is suspended with its home, and resumed on it', async () => {
    await session.writeTextFile({ path: 'kept.txt', content: 'kept' });
    await session.stop();

    const resumed = await resumeGkeNetworkSandboxSession({ ...options, sandboxId: session.id });

    expect(await resumed.readTextFile({ path: 'kept.txt' })).toBe('kept');
  });

  it('starts every later sandbox from a template, made once', async () => {
    const first = await createGkeNetworkSandboxSession({
      ...options,
      sandboxId: `e2e-${run}-t`,
      template,
    });
    sessions.push(first);

    const { stdout } = await first.run({ command: 'cat "$HOME/baked.txt"' });

    expect(stdout).toBe('baked\n');
  });
});
