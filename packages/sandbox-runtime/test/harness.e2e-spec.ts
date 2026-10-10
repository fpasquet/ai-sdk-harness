import type { HarnessV1RequestTransformation } from '@ai-sdk/harness';

import { createClaudeCode } from '@ai-sdk/harness-claude-code';
import { createHarnessSandboxTemplate, HarnessAgent } from '@ai-sdk/harness/agent';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { SrtNetworkSandboxSession } from '../src/index.js';

import { createSrtNetworkSandboxSession } from '../src/index.js';
import { RUNTIME } from './srt.js';

/**
 * A real Claude Code turn in an srt sandbox: needs what srt needs (see `test/srt.ts`), pnpm on the
 * `PATH` (corepack's will do), and a credential for Claude Code — `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` — or
 * the login of the `claude` CLI on this host. The sandbox is removed at the end.
 */
const harness = createClaudeCode();
const agent = new HarnessAgent({ harness, model: 'claude-haiku-4-5', permissionMode: 'allow-all' });

describe('Claude Code in an srt sandbox', () => {
  let sandbox: SrtNetworkSandboxSession;
  let workspace: string;

  beforeAll(async () => {
    workspace = await mkdtemp(join(homedir(), '.ai-sdk-srt-harness-e2e-'));
    sandbox = await createSrtNetworkSandboxSession({
      sandboxId: `ai-sdk-srt-harness-e2e-${randomBytes(3).toString('hex')}`,
      ports: [4000],
      workspace,
      template: await createHarnessSandboxTemplate({ harnesses: [harness] }),
      runtime: RUNTIME,
    });
  });

  afterAll(async () => {
    await sandbox?.destroy();
    await rm(workspace, { recursive: true, force: true });
  });

  it('works in the workspace, its credential held by the proxy', async () => {
    // What the harness asks the proxy to put in its requests.
    const brokered: HarnessV1RequestTransformation[] = [];
    const add = sandbox.addRequestTransformations!;
    Object.assign(sandbox, {
      addRequestTransformations: (transformations: HarnessV1RequestTransformation[]) => {
        brokered.push(...transformations);
        return add(transformations);
      },
    });
    const session = await agent.createSession({ sandboxSession: sandbox });
    try {
      const { text } = await agent.generate({
        session,
        prompt:
          'With the Bash tool, run exactly `echo from-the-agent > hello.txt`. Then answer DONE and nothing else.',
      });

      expect(text).toContain('DONE');
      // The harness works in a directory of its own, under the sandbox's working directory.
      const [file] = (await readdir(workspace, { recursive: true })).filter((path) =>
        path.endsWith('hello.txt'),
      );
      expect(await readFile(join(workspace, file ?? 'hello.txt'), 'utf8')).toBe('from-the-agent\n');

      // The sandbox only held a placeholder for the model's API: the turn went through because
      // srt's proxy put the real credential in its requests.
      const [rule] = brokered;
      expect(rule?.match.host).toBe('api.anthropic.com');
      expect(JSON.stringify(rule?.match.headers)).toMatch(/aisdkhc_[\w-]{43}/);
      expect(JSON.stringify(rule?.transform.headers)).not.toContain('aisdkhc_');
    } finally {
      await session.destroy();
    }
  });
});
