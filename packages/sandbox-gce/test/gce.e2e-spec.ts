import type { HarnessV1SandboxTemplate } from '@ai-sdk/harness';

import { randomBytes } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';

import type { GceAuth, GceNetworkSandboxSession } from '../src/index.js';

import { templateId } from '../src/client/lifecycle/sandbox-template.js';
import { identityToken } from '../src/client/transport/identity-token.js';
import { SandboxServiceClient } from '../src/client/transport/sandbox-service-client.js';
import { createGceNetworkSandboxSession, resumeGceNetworkSandboxSession } from '../src/index.js';

/**
 * Against a sandbox service deployed on Google Cloud: set GCE_SANDBOX_URL to its URL, and have
 * gcloud signed in with an account granted roles/run.invoker on it (or set GCE_SANDBOX_AUTH to
 * `none` for a service run locally). Every machine and template it makes is removed at the end.
 */
const url = process.env['GCE_SANDBOX_URL'];
const auth = (process.env['GCE_SANDBOX_AUTH'] ?? 'gcloud') as GceAuth;
const run = randomBytes(3).toString('hex');
const sessions: GceNetworkSandboxSession[] = [];
const template: HarnessV1SandboxTemplate = {
  identity: `e2e-${run}`,
  prepare: async ({ session }) => {
    const { exitCode, stderr } = await session.run({ command: 'echo baked > "$HOME/baked.txt"' });
    expect(exitCode, stderr).toBe(0);
  },
};

describe.skipIf(url === undefined)('a sandbox on Compute Engine', () => {
  const options = {
    url: url ?? '',
    auth,
    allowedHosts: ['registry.npmjs.org'],
    ports: [4000],
    serviceToken: process.env['GCE_SANDBOX_SERVICE_TOKEN'],
  };
  let session: GceNetworkSandboxSession;

  afterAll(async () => {
    await Promise.all(sessions.map((created) => created.destroy().catch(() => undefined)));
    const client = new SandboxServiceClient(options.url, {
      token: identityToken(auth, options.url),
      serviceToken: options.serviceToken,
    });
    await client.deleteTemplate(templateId({ template, setup: [] })).catch(() => undefined);
  });

  it('boots a machine of its own, and runs commands as its user', async () => {
    session = await createGceNetworkSandboxSession({ ...options, sandboxId: `e2e-${run}` });
    sessions.push(session);

    const { stdout, stderr, exitCode } = await session.run({
      command: 'id -un; pwd; sudo -n true && echo sudo',
    });

    // What the command printed on its error stream, when it fails.
    expect(exitCode, stderr).toBe(0);
    expect(stdout).toBe(`agent\n${session.defaultWorkingDirectory}\nsudo\n`);
  });

  it('writes to the stdin of a process, its close the end of the input', async () => {
    const spawned = await session.spawn({ command: 'cat; echo " (end)"', stdin: true });
    const writer = spawned.stdin.getWriter();
    for (const word of ['one ', 'two ', 'three'])
      await writer.write(new TextEncoder().encode(word));
    await writer.close();

    expect(await new Response(spawned.stdout).text()).toBe('one two three (end)\n');
    expect(await spawned.wait()).toEqual({ exitCode: 0 });
  });

  it('reaches the allowed hosts through the proxy, and nothing else', async () => {
    const { stdout } = await session.run({
      command:
        'curl -sS -o /dev/null -w "%{http_code}\\n" https://registry.npmjs.org/ai; ' +
        'curl -sS -o /dev/null -w "%{http_code}\\n" https://example.com/ || true; ' +
        'curl -sS --noproxy "*" --max-time 5 https://registry.npmjs.org/ai >/dev/null 2>&1 || echo direct-refused; ' +
        'curl -sS --noproxy "*" --max-time 5 -H "Metadata-Flavor: Google" http://169.254.169.254/computeMetadata/v1/instance/service-accounts/ || echo no-account',
    });

    expect(stdout).toMatch(/^200\n(403|000)\n/);
    expect(stdout).toContain('direct-refused');
    expect(stdout).not.toContain('default/');
  });

  it('runs Docker, its images pulled through the proxy', async () => {
    await session.setNetworkPolicy({
      mode: 'custom',
      // Docker Hub serves layers from either CDN.
      allowedHosts: [
        'registry-1.docker.io',
        'auth.docker.io',
        'production.cloudflare.docker.com',
        'production.cloudfront.docker.com',
      ],
    });

    const { stdout, stderr, exitCode } = await session.run({
      command: 'docker run --rm hello-world',
    });

    expect(exitCode, stderr).toBe(0);
    expect(stdout).toContain('Hello from Docker!');
  });

  it('is stopped with its disk, and resumed on it', async () => {
    await session.writeTextFile({ path: 'kept.txt', content: 'kept' });
    await session.stop();

    const resumed = await resumeGceNetworkSandboxSession({ ...options, sandboxId: session.id });

    const kept = await resumed.readTextFile({ path: 'kept.txt' });

    expect(kept).toBe('kept');
  });

  it('boots every later sandbox from a template, made once', async () => {
    const first = await createGceNetworkSandboxSession({
      ...options,
      sandboxId: `e2e-${run}-t`,
      template,
    });
    sessions.push(first);

    const { stdout } = await first.run({ command: 'cat "$HOME/baked.txt"' });

    expect(stdout).toBe('baked\n');
  });
});
