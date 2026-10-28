import type { SbxNetworkSandboxSession } from 'ai-sdk-sandbox-sbx';

import { createClaudeCode } from '@ai-sdk/harness-claude-code';
import { createHarnessSandboxTemplate, HarnessAgent } from '@ai-sdk/harness/agent';
import { createSessionManager, sharedSandbox } from 'ai-sdk-harness-sessions';
import { createSbxNetworkSandboxSession } from 'ai-sdk-sandbox-sbx';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { SingleRepositoryWorkspaceSession, Workspace, WorkspaceSource } from '../src/index.js';

import {
  createWorkspace,
  gitRepository,
  hostRepository,
  sandboxRepository,
  withWorkspace,
} from '../src/index.js';
import { createSourceRepository, git } from './host-sandbox.js';

/**
 * Real Claude Code sessions working in checkouts of one Docker Sandbox: needs `sbx` signed in, and
 * a credential for Claude Code — `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`, or the login of
 * the `claude` CLI on this host. The brokered fetch from GitHub needs `GITHUB_TOKEN`, or the login
 * of the `gh` CLI, and is skipped without either. The sandbox is removed at the end.
 */
const harness = createClaudeCode();
const settings = { harness, model: 'claude-haiku-4-5', permissionMode: 'allow-all' } as const;

function githubToken(): string | undefined {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim() || undefined;
  } catch {
    return undefined;
  }
}

describe('workspaces on a real runtime', () => {
  let sandbox: SbxNetworkSandboxSession;
  let source: string;
  let workspace: Workspace<SingleRepositoryWorkspaceSession>;
  let sessions: ReturnType<typeof createSessionManager>;

  /** Sends a message, reads the turn to its end. */
  async function say(id: string, message: string): Promise<string> {
    const turn = await sessions.send(id, { message });
    for await (const _chunk of turn.stream);
    const session = await turn.done;
    expect(session.error).toBeUndefined();
    const last = (await sessions.get(id))?.messages.at(-1);
    return last?.parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('') ?? '';
  }

  /** Whether `path` exists in the sandbox. */
  const existsInSandbox = async (path: string) =>
    (await sandbox.run({ command: `test -e '${path}'` })).exitCode === 0;

  beforeAll(async () => {
    source = await createSourceRepository();
    sandbox = await createSbxNetworkSandboxSession({
      sandboxId: `ai-sdk-workspace-e2e-${randomBytes(3).toString('hex')}`,
      ports: [4001, 4002, 4003],
      setup: ['npm install --global --silent pnpm@10'],
      // sbx mounts a read-only directory beside a primary workspace only, read-write.
      workspace: await mkdtemp(join(tmpdir(), 'harness-workspace-e2e-')),
      readOnlyWorkspaces: [source],
      template: await createHarnessSandboxTemplate({ harnesses: [harness] }),
    });
    workspace = createWorkspace({ source: hostRepository({ path: source }) });
    sessions = createSessionManager({
      agent: () => new HarnessAgent(withWorkspace(settings, workspace)),
      sandboxes: workspace.sandboxes(
        sharedSandbox({ open: () => Promise.resolve(sandbox), ports: [4001, 4002] }),
      ),
    });
  });

  afterAll(async () => {
    await sessions?.shutdown();
    await sandbox?.destroy();
  });

  it('gives each session a checkout of its own, and reads back what each agent changed', async () => {
    await sessions.create({ id: 'alpha', metadata: {} });
    await sessions.create({ id: 'beta', metadata: {} });

    await Promise.all([
      say(
        'alpha',
        'In index.js, change 41 to 42 with the Edit tool. Do not commit. Answer "done".',
      ),
      say(
        'beta',
        'Create a file NOTES.md containing the line "beta", then commit it with git (message "Notes"). Answer "done".',
      ),
    ]);

    const alpha = workspace.session('alpha')!;
    const beta = workspace.session('beta')!;
    expect(alpha.directory).not.toBe(beta.directory);
    expect(alpha.base).toBe(await git(source, 'rev-parse', 'HEAD'));
    const repository = source.split('/').at(-1)!;
    expect(await alpha.changedFiles()).toEqual([
      {
        path: 'index.js',
        repository,
        status: 'modified',
        additions: 1,
        deletions: 1,
        binary: false,
        mode: '100644',
      },
    ]);
    expect(new TextDecoder().decode(await alpha.changes())).toContain('+export const answer = 42;');
    const [edited] = await alpha.changedFiles({ contents: true });
    expect(new TextDecoder().decode(edited?.content)).toContain('export const answer = 42;');
    expect(await beta.changedFiles()).toEqual([
      {
        path: 'NOTES.md',
        repository,
        status: 'added',
        additions: 1,
        deletions: 0,
        binary: false,
        mode: '100644',
      },
    ]);
    expect((await beta.run('git log -1 --format=%s')).stdout).toMatch(/^Notes/);
  });

  it('keeps the checkout of a suspended session, and finds it again when it resumes', async () => {
    const { directory } = workspace.session('alpha')!;
    await sessions.suspend('alpha');
    expect(workspace.session('alpha')).toBeUndefined();

    const answer = await say('alpha', 'Run `git status --short` and answer with its output only.');

    expect(answer).toContain('index.js');
    expect(workspace.session('alpha')?.directory).toBe(directory);
  });

  it('removes the checkout of a session when it is closed', async () => {
    const { directory } = workspace.session('alpha')!;

    await sessions.close('alpha');

    expect(await existsInSandbox(directory)).toBe(false);
    expect(await existsInSandbox(workspace.session('beta')!.directory)).toBe(true);
  });

  /** Checks out `from` for one session, on a view of the sandbox of its own: its checkout. */
  async function checkOut(from: WorkspaceSource, sessionId: string) {
    const other = createWorkspace({ source: from });
    const view = sandbox.fork({ ports: [4003] });
    const lease = other.open({ sessionId, sandboxSession: view });
    const agent = new HarnessAgent(withWorkspace(settings, other));
    const session = await agent.createSession({ sessionId, sandboxSession: lease.sandboxSession });
    const checkout = other.session(sessionId)!;
    const files = (await checkout.run('git ls-files')).stdout.split('\n');
    await session.destroy();
    await lease.close();
    await view.release();
    return { checkout, files };
  }

  it('checks out a repository mounted in the sandbox', async () => {
    const { checkout, files } = await checkOut(sandboxRepository({ path: source }), 'delta');

    expect(checkout.base).toBe(await git(source, 'rev-parse', 'HEAD'));
    expect(files).toContain('index.js');
  });

  it('checks several repositories out side by side, and reads back what changed in each', async () => {
    const web = await createSourceRepository();
    const several = createWorkspace({
      repositories: {
        api: hostRepository({ path: source, name: 'e2e-api' }),
        web: hostRepository({ path: web, name: 'e2e-web' }),
      },
    });
    const view = sandbox.fork({ ports: [4003] });
    const lease = several.open({ sessionId: 'zeta', sandboxSession: view });
    const agent = new HarnessAgent(withWorkspace(settings, several));
    const session = await agent.createSession({
      sessionId: 'zeta',
      sandboxSession: lease.sandboxSession,
    });
    const { directory } = several.session('zeta')!;
    try {
      await agent.generate({
        session,
        prompt:
          'In api/index.js, change 41 to 42 with the Edit tool. Then create web/NOTES.md containing the line "web". Do not commit. Answer "done".',
      });

      const checkouts = several.session('zeta')!;
      expect(
        (await checkouts.changedFiles()).map(({ path, repository }) => ({ path, repository })),
      ).toEqual([
        { path: 'api/index.js', repository: 'api' },
        { path: 'web/NOTES.md', repository: 'web' },
      ]);
      expect(checkouts.repository('api')!.base).toBe(await git(source, 'rev-parse', 'HEAD'));
      expect(new TextDecoder().decode(await checkouts.changes())).toContain('+++ b/web/NOTES.md');
      expect(new TextDecoder().decode(await checkouts.repository('api')!.changes())).toContain(
        '+++ b/index.js',
      );
    } finally {
      await session.destroy();
      await lease.close();
      await view.release();
    }
    expect(await existsInSandbox(directory)).toBe(false);
  });

  it.skipIf(githubToken() === undefined)(
    'fetches a repository from GitHub, the token brokered rather than handed to the sandbox',
    async () => {
      const token = githubToken()!;
      const from = gitRepository({
        url: 'https://github.com/octocat/Hello-World.git',
        credentials: () => Promise.resolve({ token }),
      });

      const { files } = await checkOut(from, 'epsilon');

      expect(files).toContain('README');
      const environment = await sandbox.run({
        command: 'env; cat ~/.ai-sdk-harness/repositories/*/config',
      });
      expect(environment.stdout).not.toContain(token);
    },
  );
});
