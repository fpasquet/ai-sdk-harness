import type { SbxNetworkSandboxSession } from 'ai-sdk-sandbox-sbx';

import { createClaudeCode } from '@ai-sdk/harness-claude-code';
import { createCodex } from '@ai-sdk/harness-codex';
import { createHarnessSandboxTemplate, HarnessAgent } from '@ai-sdk/harness/agent';
import { createSbxNetworkSandboxSession } from 'ai-sdk-sandbox-sbx';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { harnessHosts, networkPolicy, trustedHosts } from '../src/index.js';

/**
 * The presets against the real services, from a Docker Sandbox whose network lets them through and
 * nothing else: needs `sbx` signed in, and a credential for each runtime — `CLAUDE_CODE_OAUTH_TOKEN`
 * or `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`, or the login of the `claude` and `codex` CLIs on
 * this host. The sandbox is removed at the end; the template image, shared with the example, is
 * kept.
 */
const RUNTIMES = {
  'claude-code': { create: createClaudeCode, model: 'claude-haiku-4-5' },
  codex: { create: createCodex, model: 'gpt-5.5' },
} as const;

describe('the presets, in a sandbox closed to everything else', () => {
  let sandbox: SbxNetworkSandboxSession;

  /** The HTTP status `url` answers the sandbox with: `403` when the proxy refuses it. */
  const status = async (url: string): Promise<string> =>
    (await sandbox.run({ command: `curl -s -m 15 -o /dev/null -w '%{http_code}' '${url}'` }))
      .stdout;

  beforeAll(async () => {
    sandbox = await createSbxNetworkSandboxSession({
      sandboxId: `ai-sdk-network-e2e-${randomBytes(3).toString('hex')}`,
      ports: [4000],
      setup: ['npm install --global --silent pnpm@10'],
      template: await createHarnessSandboxTemplate({
        harnesses: [createClaudeCode(), createCodex()],
      }),
      networkPolicy: networkPolicy(trustedHosts()),
    });
  });

  afterAll(async () => {
    await sandbox?.destroy();
  });

  it('reaches what GitHub serves: Git, the API, archives and raw files', async () => {
    expect(await status('https://github.com/octocat/Hello-World')).toBe('200');
    expect(await status('https://api.github.com/repos/octocat/Hello-World')).toBe('200');
    expect(
      await status('https://codeload.github.com/octocat/Hello-World/tar.gz/refs/heads/master'),
    ).toBe('200');
    expect(
      await status('https://raw.githubusercontent.com/octocat/Hello-World/master/README'),
    ).toBe('200');
    const clone = await sandbox.run({
      command:
        'git clone -q --depth 1 https://github.com/octocat/Hello-World /tmp/hello && ls /tmp/hello',
    });
    expect(clone.stdout).toContain('README');
  });

  it('reaches the registries of npm, Yarn and PyPI, and the files of a Python package', async () => {
    expect(await status('https://registry.npmjs.org/zod')).toBe('200');
    expect(await status('https://registry.yarnpkg.com/zod')).toBe('200');
    expect(await status('https://repo.yarnpkg.com/tags')).toBe('200');
    expect(await status('https://pypi.org/simple/six/')).toBe('200');
    const { stdout: wheel } = await sandbox.run({
      command: `curl -s -m 15 https://pypi.org/pypi/six/json | grep -o 'https://files.pythonhosted.org/[^"]*\\.whl' | head -n 1`,
    });
    expect(await status(wheel.trim())).toBe('200');
  });

  it('reaches nothing else', async () => {
    expect(await status('https://example.com')).toBe('403');
    expect(await status('https://api.anthropic.com')).toBe('403');
  });

  it.each(['claude-code', 'codex'] as const)(
    '%s runs a turn with the npm registry and its own hosts only',
    async (runtime) => {
      await sandbox.setNetworkPolicy?.(networkPolicy(trustedHosts('npm'), harnessHosts(runtime)));
      const { create, model } = RUNTIMES[runtime];
      const agent = new HarnessAgent({ harness: create(), model });
      const session = await agent.createSession({ sandboxSession: sandbox });
      try {
        const result = await agent.generate({
          session,
          prompt: 'Run `echo ready` in the shell, then answer with its output alone.',
        });
        expect(result.text.toLowerCase()).toContain('ready');
      } finally {
        await session.destroy();
      }
    },
  );
});
