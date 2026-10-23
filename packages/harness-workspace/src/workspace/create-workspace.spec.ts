import type { HarnessV1NetworkSandboxSession } from '@ai-sdk/harness';

import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import type { HostSandbox } from '../../test/host-sandbox.js';
import type { WorkspaceSource } from '../definitions/source.js';
import type {
  SessionSandboxes,
  SingleRepositoryWorkspaceSession,
  Workspace,
  WorkspaceRepositories,
  WorkspaceSession,
} from '../definitions/workspace.js';

import {
  createHostSandbox,
  createSourceRepository,
  git,
  GIT_ENV,
  sessionWorkDir,
} from '../../test/host-sandbox.js';
import { WorkspaceError } from '../errors/workspace-error.js';
import { WorkspaceLostError } from '../errors/workspace-lost-error.js';
import { WorkspaceSetupError } from '../errors/workspace-setup-error.js';
import { gitRepository } from '../sources/git-repository.js';
import { hostRepository } from '../sources/host-repository.js';
import { sandboxRepository } from '../sources/sandbox-repository.js';
import { createWorkspace } from './create-workspace.js';
import { withWorkspace } from './with-workspace.js';

/** Sandboxes that give every session the one stand-in sandbox, and keep what they are asked. */
function hostSandboxes(
  sandbox: HarnessV1NetworkSandboxSession,
  events: string[],
): SessionSandboxes {
  return {
    capacity: 4,
    acquire: (sessionId, { resume }) => {
      events.push(`acquire ${sessionId}${resume ? ' (resume)' : ''}`);
      return Promise.resolve({
        sandboxSession: sandbox,
        suspend: () => {
          events.push(`suspend ${sessionId}`);
          return Promise.resolve();
        },
        close: () => {
          events.push(`close ${sessionId}`);
          return Promise.resolve();
        },
      });
    },
    shutdown: () => {
      events.push('shutdown');
      return Promise.resolve();
    },
  };
}

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

describe('createWorkspace', () => {
  let host: HostSandbox;
  let source: string;
  let events: string[];
  let workspace: Workspace<SingleRepositoryWorkspaceSession>;
  let sandboxes: SessionSandboxes;

  beforeEach(async () => {
    host = await createHostSandbox();
    source = await createSourceRepository();
    events = [];
    workspace = createWorkspace({ source: sandboxRepository({ path: source }) });
    sandboxes = workspace.sandboxes(hostSandboxes(host.sandbox, events));
  });

  /** Starts session `id` as the session manager and the harness would: its working directory. */
  async function start(
    id: string,
    options: { resume?: boolean; workspace?: Workspace<WorkspaceSession> } = {},
  ) {
    const used = options.workspace ?? workspace;
    const lease = await (
      options.workspace ? used.sandboxes(hostSandboxes(host.sandbox, events)) : sandboxes
    ).acquire(id, { resume: options.resume ?? false });
    const directory = await sessionWorkDir(lease.sandboxSession, id);
    const settings = withWorkspace({ harness: { harnessId: 'claude-code' } }, used);
    await settings.sandboxConfig.onSession!({
      session: lease.sandboxSession.restricted(),
      sessionWorkDir: directory,
    });
    return { lease, directory };
  }

  it('checks the repository out for each session, side by side, each on a branch of its own', async () => {
    const first = await start('a');
    const second = await start('b');
    const head = await git(source, 'rev-parse', 'HEAD');

    expect(await readFile(join(first.directory, 'index.js'), 'utf8')).toBe(
      'export const answer = 41;\n',
    );
    expect(await git(first.directory, 'branch', '--show-current')).toBe('session/a');
    expect(await git(second.directory, 'branch', '--show-current')).toBe('session/b');
    expect(workspace.session('a')).toMatchObject({
      sessionId: 'a',
      directory: first.directory,
      base: head,
    });
    // The repository is kept bare, in the sandbox user's home, outside the working directories.
    const repository = join(
      host.home,
      '.ai-sdk-harness/repositories',
      `${source.split('/').at(-1)}.git`,
    );
    expect(await git(repository, 'rev-parse', '--is-bare-repository')).toBe('true');
    expect(
      await git(first.directory, 'rev-parse', '--path-format=absolute', '--git-common-dir'),
    ).toBe(repository);
    expect(events).toEqual(['acquire a', 'acquire b']);
  });

  it('reads back what the agent changed, its commits included, as a patch git applies', async () => {
    const { directory } = await start('a');
    await writeFile(join(directory, 'index.js'), 'export const answer = 42;\n');
    await writeFile(join(directory, 'new.txt'), 'new\n');
    await unlink(join(directory, 'old.txt'));
    await writeFile(join(directory, 'logo.bin'), Buffer.from([0, 1, 2, 3, 4]));
    await mkdir(join(directory, 'node_modules'));
    await writeFile(join(directory, 'node_modules/ignored.js'), 'ignored\n');
    await git(directory, 'add', 'new.txt');
    await git(directory, 'commit', '--quiet', '-m', 'An agent commit');
    await writeFile(join(directory, 'README.md'), '# Widgets\n\nEdited after the commit.\n');

    const session = workspace.session('a')!;
    const patch = await session.changes();
    const files = await session.changedFiles();

    const repository = source.split('/').at(-1)!;
    expect(files.toSorted((x, y) => (x.path < y.path ? -1 : 1))).toEqual(
      [
        { path: 'README.md', status: 'modified', additions: 2, deletions: 0, binary: false },
        { path: 'index.js', status: 'modified', additions: 1, deletions: 1, binary: false },
        { path: 'logo.bin', status: 'modified', additions: 0, deletions: 0, binary: true },
        { path: 'new.txt', status: 'added', additions: 1, deletions: 0, binary: false },
        { path: 'old.txt', status: 'deleted', additions: 0, deletions: 1, binary: false },
      ].map((file) => ({ ...file, repository })),
    );
    expect(session.repositories.map(({ name, directory: at }) => ({ name, at }))).toEqual([
      { name: repository, at: directory },
    ]);
    expect(await session.repository(repository)!.changes()).toEqual(patch);
    // Applied to the source as it was, the patch gives the checkout back.
    const copy = await mkdtemp(join(tmpdir(), 'harness-workspace-apply-'));
    await git(copy, 'clone', '--quiet', source, '.');
    const patchFile = join(copy, '..', `${copy.split('/').at(-1)}.patch`);
    await writeFile(patchFile, patch);
    await git(copy, 'apply', '--binary', patchFile);
    expect(await readFile(join(copy, 'index.js'), 'utf8')).toBe('export const answer = 42;\n');
    expect([...(await readFile(join(copy, 'logo.bin')))]).toEqual([0, 1, 2, 3, 4]);
    expect(await exists(join(copy, 'old.txt'))).toBe(false);
    expect(await exists(join(copy, 'node_modules'))).toBe(false);
  });

  it("leaves the agent's own index as it was", async () => {
    const { directory } = await start('a');
    await writeFile(join(directory, 'index.js'), 'export const answer = 42;\n');
    await writeFile(join(directory, 'untracked.txt'), 'untracked\n');
    const before = await git(directory, 'status', '--porcelain');

    await workspace.session('a')!.changes();

    expect(await git(directory, 'status', '--porcelain')).toBe(before);
    expect(before).toContain('?? untracked.txt');
  });

  it('keeps local files out of the changes, whether the repository has them or not', async () => {
    const { directory } = await start('a');
    const session = workspace.session('a')!;

    await session.writeLocalFile('.env.local', 'TOKEN=placeholder\n');
    await session.writeLocalFile('README.md', '# Local notes\n');
    await session.writeLocalFile('config/[weird]*.json', new Uint8Array([123, 125]));

    expect(await readFile(join(directory, '.env.local'), 'utf8')).toBe('TOKEN=placeholder\n');
    expect(await readFile(join(directory, 'README.md'), 'utf8')).toBe('# Local notes\n');
    expect(await readFile(join(directory, 'config/[weird]*.json'), 'utf8')).toBe('{}');
    expect(await session.changedFiles()).toEqual([]);
    expect((await session.changes()).length).toBe(0);
    await expect(session.writeLocalFile('../escape', 'no')).rejects.toThrow(TypeError);
    await expect(session.writeLocalFile('.git/config', 'no')).rejects.toThrow(TypeError);
  });

  it('runs commands in the checkout', async () => {
    await start('a');
    const session = workspace.session('a')!;

    const result = await session.run('pwd && cat index.js && echo "$GREETING" >&2', {
      env: { GREETING: 'hello' },
    });

    expect(result).toEqual({
      exitCode: 0,
      stdout: `${session.directory}\nexport const answer = 41;\n`,
      stderr: 'hello\n',
    });
    await expect(session.run('sleep 5', { timeoutMs: 50 })).rejects.toThrow();
  });

  it("keeps a suspended session's checkout, finds it again when the session resumes, and removes it when it is closed", async () => {
    const { lease, directory } = await start('a');
    await writeFile(join(directory, 'index.js'), 'export const answer = 42;\n');
    const base = workspace.session('a')!.base;
    // A commit on the source meanwhile does not move a resumed session.
    await writeFile(join(source, 'index.js'), 'export const answer = 43;\n');
    await git(source, 'commit', '--quiet', '-am', 'Third');

    await lease.suspend();
    expect(workspace.session('a')).toBeUndefined();
    const resumed = await start('a', { resume: true });

    expect(resumed.directory).toBe(directory);
    expect(workspace.session('a')!.base).toBe(base);
    expect((await workspace.session('a')!.changedFiles()).map(({ path }) => path)).toEqual([
      'index.js',
    ]);

    await resumed.lease.close();
    expect(await exists(directory)).toBe(false);
    const repository = join(
      host.home,
      '.ai-sdk-harness/repositories',
      `${source.split('/').at(-1)}.git`,
    );
    expect(await git(repository, 'branch', '--list', 'session/a')).toBe('');
    expect(await git(repository, 'for-each-ref', 'refs/ai-sdk-harness/')).toBe('');
    expect(events).toEqual(['acquire a', 'suspend a', 'acquire a (resume)', 'close a']);
  });

  it('refuses to resume a session whose checkout is gone', async () => {
    const { lease, directory } = await start('a');
    await lease.suspend();
    await rm(directory, { recursive: true, force: true });

    const resuming = start('a', { resume: true });

    await expect(resuming).rejects.toThrow(WorkspaceLostError);
    await expect(resuming).rejects.toSatisfy((error) => WorkspaceError.isInstance(error));
  });

  it('keeps the checkout a start made when the start is tried again', async () => {
    const { directory } = await start('a');
    await writeFile(join(directory, 'index.js'), 'export const answer = 42;\n');

    // The harness failed after onSession: the session starts afresh in the same directory.
    await start('a');

    expect(await readFile(join(directory, 'index.js'), 'utf8')).toBe('export const answer = 42;\n');
  });

  it('refuses a working directory something was written in before the checkout', async () => {
    await mkdir(join(host.sandbox.defaultWorkingDirectory, 'claude-code-a'), { recursive: true });
    await writeFile(join(host.sandbox.defaultWorkingDirectory, 'claude-code-a', 'stray.txt'), 'x');

    await expect(start('a')).rejects.toThrow(/is not empty/);
  });

  it('runs the setup commands in a new checkout only, and fails the start when one fails', async () => {
    const withSetup = createWorkspace({
      source: sandboxRepository({ path: source }),
      setup: ['echo "$MODE" > setup.log', 'echo again >> setup.log'],
      setupEnv: { MODE: 'install' },
    });
    const { lease, directory } = await start('a', { workspace: withSetup });
    expect(await readFile(join(directory, 'setup.log'), 'utf8')).toBe('install\nagain\n');
    await lease.suspend();
    await unlink(join(directory, 'setup.log'));
    await start('a', { workspace: withSetup, resume: true });
    expect(await exists(join(directory, 'setup.log'))).toBe(false);

    const failing = createWorkspace({
      source: sandboxRepository({ path: source }),
      setup: 'echo broken >&2; exit 3',
    });
    const starting = start('b', { workspace: failing });
    await expect(starting).rejects.toThrow(WorkspaceSetupError);
    await expect(starting).rejects.toMatchObject({
      exitCode: 3,
      command: 'echo broken >&2; exit 3',
    });
  });

  it("finds the session's checkout from the sandbox a tool is given", async () => {
    const { lease } = await start('a');

    expect(workspace.fromSandbox(lease.sandboxSession.restricted())?.sessionId).toBe('a');
    expect(workspace.fromSandbox(host.sandbox.restricted())).toBeUndefined();
  });

  it('refuses a sandbox that does not come from the workspace', async () => {
    const directory = await sessionWorkDir(host.sandbox, 'a');

    await expect(
      workspace.onSession({ session: host.sandbox.restricted(), sessionWorkDir: directory }),
    ).rejects.toThrow(/does not come from this workspace/);
  });

  it("removes a suspended session's checkout when the session is closed", async () => {
    const { lease, directory } = await start('a');
    await lease.suspend();

    await sandboxes.discard!('a');

    expect(await exists(directory)).toBe(false);
    expect(events).toEqual(['acquire a', 'suspend a', 'acquire a (resume)', 'close a']);
    await sandboxes.shutdown!();
    expect(events.at(-1)).toBe('shutdown');
    expect(sandboxes.capacity).toBe(4);
  });

  it('works without a session manager, on a sandbox it does not stop', async () => {
    const lease = workspace.open({ sessionId: 'a', sandboxSession: host.sandbox });
    const directory = await sessionWorkDir(lease.sandboxSession, 'a');
    await workspace.onSession({
      session: lease.sandboxSession.restricted(),
      sessionWorkDir: directory,
    });

    expect(workspace.session('a')?.directory).toBe(directory);
    await lease.close();
    expect(workspace.session('a')).toBeUndefined();
    expect(await exists(directory)).toBe(false);
  });

  it('gives the agents an identity to commit with, unless git has one', async () => {
    const { directory } = await start('a');

    await writeFile(join(directory, 'new.txt'), 'new\n');
    const committed = await new Promise<string>((resolve, reject) => {
      execFile(
        'sh',
        ['-c', 'git add new.txt && git commit --quiet -m agent && git log -1 --format="%an <%ae>"'],
        { cwd: directory, env: { ...process.env, ...GIT_ENV } },
        (error, stdout, stderr) => (error ? reject(new Error(stderr)) : resolve(stdout.trim())),
      );
    });

    expect(committed).toBe('Harness agent <agent@ai-sdk-harness.invalid>');
  });

  it('names the hosts the sandbox fetches the repository from', async () => {
    const hosts = createWorkspace({
      source: gitRepository({ url: 'https://github.com/acme/widgets.git' }),
    }).hosts();

    expect(await hosts).toEqual(['github.com']);
    expect(await workspace.hosts({ sessionId: 'a' })).toEqual([]);
  });

  it('refuses a branch name git would not take', async () => {
    const odd = createWorkspace({
      source: sandboxRepository({ path: source }),
      branch: () => 'bad..name',
    });

    await expect(start('a', { workspace: odd })).rejects.toThrow(/not a valid branch name/);
    expect(() =>
      createWorkspace({ source: sandboxRepository({ path: source }), repositoryPath: 'relative' }),
    ).toThrow(TypeError);
  });

  it('names the branch of a session whose id does not fit in one after a hash of it', async () => {
    const { directory } = await start('a user/session id');

    expect(await git(directory, 'branch', '--show-current')).toMatch(/^session\/[0-9a-f]{32}$/);
  });

  describe('with several repositories', () => {
    let web: string;
    let several: Workspace;

    beforeEach(async () => {
      web = await createSourceRepository();
      several = createWorkspace({
        repositories: {
          api: {
            source: sandboxRepository({ path: source }),
            // In a directory the repository ignores: kept out of its changes.
            setup: 'mkdir -p node_modules && echo "$MODE $SIDE" > node_modules/setup.log',
            setupEnv: { SIDE: 'api' },
          },
          'apps/web': sandboxRepository({ path: web }),
        },
        setup:
          'test -e api/node_modules/setup.log && test -e apps/web/.git && echo ready > root.log',
        setupEnv: { MODE: 'install' },
      });
    });

    it('checks each repository out in a directory of the working directory, on the same branch', async () => {
      const { directory } = await start('a', { workspace: several });
      const session = several.session('a')!;

      expect(session.directory).toBe(directory);
      expect(session).not.toHaveProperty('base');
      expect(session.repositories.map(({ name, directory: at }) => ({ name, at }))).toEqual([
        { name: 'api', at: join(directory, 'api') },
        { name: 'apps/web', at: join(directory, 'apps/web') },
      ]);
      expect(session.repository('api')!.base).toBe(await git(source, 'rev-parse', 'HEAD'));
      expect(session.repository('apps/web')!.base).toBe(await git(web, 'rev-parse', 'HEAD'));
      expect(session.repository('nope')).toBeUndefined();
      expect(await git(join(directory, 'api'), 'branch', '--show-current')).toBe('session/a');
      expect(await git(join(directory, 'apps/web'), 'branch', '--show-current')).toBe('session/a');
      // Each repository's setup in its checkout, then the workspace's in the working directory.
      expect(await readFile(join(directory, 'api/node_modules/setup.log'), 'utf8')).toBe(
        'install api\n',
      );
      expect(await readFile(join(directory, 'root.log'), 'utf8')).toBe('ready\n');
      expect((await session.run('ls')).stdout).toBe('api\napps\nroot.log\n');
    });

    it('reads back the changes of every repository, or of one', async () => {
      const { directory } = await start('a', { workspace: several });
      await writeFile(join(directory, 'api/index.js'), 'export const answer = 42;\n');
      await writeFile(join(directory, 'apps/web/new.txt'), 'new\n');
      await writeFile(join(directory, 'notes.md'), 'In no repository.\n');
      const session = several.session('a')!;
      await session.writeLocalFile('api/.env.local', 'TOKEN=placeholder\n');
      await session.writeLocalFile('local.txt', 'local\n');

      const all = await session.changedFiles();
      const patch = await session.changes();

      expect(all).toEqual([
        {
          path: 'api/index.js',
          repository: 'api',
          status: 'modified',
          additions: 1,
          deletions: 1,
          binary: false,
        },
        {
          path: 'apps/web/new.txt',
          repository: 'apps/web',
          status: 'added',
          additions: 1,
          deletions: 0,
          binary: false,
        },
      ]);
      expect(await session.repository('apps/web')!.changedFiles()).toEqual([
        {
          path: 'new.txt',
          repository: 'apps/web',
          status: 'added',
          additions: 1,
          deletions: 0,
          binary: false,
        },
      ]);
      expect(await readFile(join(directory, 'api/.env.local'), 'utf8')).toBe('TOKEN=placeholder\n');
      expect(await readFile(join(directory, 'local.txt'), 'utf8')).toBe('local\n');
      // Applied in a directory holding the sources as they were, the patch gives the checkouts back.
      const copy = await mkdtemp(join(tmpdir(), 'harness-workspace-apply-'));
      await git(copy, 'clone', '--quiet', source, 'api');
      await git(copy, 'clone', '--quiet', web, 'apps/web');
      const patchFile = `${copy}.patch`;
      await writeFile(patchFile, patch);
      await git(copy, 'apply', '--binary', patchFile);
      expect(await readFile(join(copy, 'api/index.js'), 'utf8')).toBe(
        'export const answer = 42;\n',
      );
      expect(await readFile(join(copy, 'apps/web/new.txt'), 'utf8')).toBe('new\n');
      expect(new TextDecoder().decode(await session.repository('api')!.changes())).toContain(
        'a/index.js',
      );
    });

    it('finds every checkout again when the session resumes, and removes them all when it is closed', async () => {
      const { lease, directory } = await start('a', { workspace: several });
      await lease.suspend();
      const resumed = await start('a', { workspace: several, resume: true });
      expect(several.session('a')!.repository('api')!.directory).toBe(join(directory, 'api'));

      await resumed.lease.close();

      expect(await exists(directory)).toBe(false);
      for (const from of [source, web]) {
        const repository = join(
          host.home,
          '.ai-sdk-harness/repositories',
          `${from.split('/').at(-1)}.git`,
        );
        expect(await git(repository, 'branch', '--list', 'session/a')).toBe('');
      }
    });

    it("removes a suspended session's checkouts and its working directory when it is closed", async () => {
      const used = several.sandboxes(hostSandboxes(host.sandbox, events));
      const lease = await used.acquire('a', { resume: false });
      const directory = await sessionWorkDir(lease.sandboxSession, 'a');
      await several.onSession({
        session: lease.sandboxSession.restricted(),
        sessionWorkDir: directory,
      });
      await lease.suspend();

      await used.discard!('a');

      expect(await exists(directory)).toBe(false);
    });

    it('says which checkout is gone when one is', async () => {
      const { lease, directory } = await start('a', { workspace: several });
      await lease.suspend();
      await rm(join(directory, 'apps/web'), { recursive: true, force: true });

      await expect(start('a', { workspace: several, resume: true })).rejects.toMatchObject({
        name: 'WorkspaceLostError',
        sessionId: 'a',
        repository: 'apps/web',
      });
    });

    it('names the hosts the sandbox fetches the repositories from, each once', async () => {
      const hosts = createWorkspace({
        repositories: {
          api: { source: gitRepository({ url: 'https://github.com/acme/api.git' }) },
          web: gitRepository({ url: 'https://github.com/acme/web.git' }),
          billing: gitRepository({ url: 'https://git.example.com:8443/acme/billing.git' }),
          docs: hostRepository({ path: source }),
          'apps/web': sandboxRepository({ path: web }),
          custom: { name: 'custom', fetch: () => Promise.resolve() },
        },
      }).hosts();

      expect(await hosts).toEqual(['github.com', 'git.example.com']);
      expect(await several.hosts()).toEqual([]);
    });

    it('refuses repositories that cannot be checked out side by side', () => {
      const from = sandboxRepository({ path: source });
      const other = sandboxRepository({ path: web });
      const refused = (repositories: Record<string, WorkspaceSource>) => () =>
        createWorkspace({ repositories });

      expect(refused({})).toThrow(/at least one/);
      expect(refused({ '../api': from })).toThrow(/relative and normalized/);
      expect(refused({ 'api/': from })).toThrow(/relative and normalized/);
      expect(refused({ '.': from })).toThrow(/relative and normalized/);
      expect(refused({ apps: from, 'apps/web': other })).toThrow(/within "apps"/);
      expect(
        refused({ api: from, web: sandboxRepository({ path: source, name: 'other' }) }),
      ).not.toThrow();
      expect(refused({ api: from, again: sandboxRepository({ path: source }) })).toThrow(
        /same repository of the sandbox/,
      );
    });
  });

  describe('with repositories chosen per session', () => {
    let web: string;
    let asked: string[];
    let perSession: Workspace;

    beforeEach(async () => {
      web = await createSourceRepository();
      asked = [];
      // Two projects: session `a` works on the API, every other one on the API and the web app.
      perSession = createWorkspace({
        repositories: ({ sessionId }) => {
          asked.push(sessionId);
          const repositories: WorkspaceRepositories = { api: sandboxRepository({ path: source }) };
          if (sessionId !== 'a') repositories['web'] = sandboxRepository({ path: web });
          return Promise.resolve(repositories);
        },
      });
    });

    it('checks out the repositories of each session, one workspace serving them all', async () => {
      const first = await start('a', { workspace: perSession });
      const second = await start('b', { workspace: perSession });

      expect(asked).toEqual(['a', 'b']);
      expect(perSession.session('a')!.repositories.map(({ name }) => name)).toEqual(['api']);
      expect(perSession.session('b')!.repositories.map(({ name }) => name)).toEqual(['api', 'web']);
      expect(await exists(join(first.directory, 'web'))).toBe(false);
      expect(await git(join(second.directory, 'web'), 'branch', '--show-current')).toBe(
        'session/b',
      );
    });

    it('asks again when a session resumes, and when a suspended one is closed', async () => {
      const used = perSession.sandboxes(hostSandboxes(host.sandbox, events));
      const { lease, directory } = await start('b', { workspace: perSession });
      await lease.suspend();
      const resumed = await start('b', { workspace: perSession, resume: true });
      expect(perSession.session('b')!.repository('web')!.directory).toBe(join(directory, 'web'));
      await resumed.lease.suspend();

      await used.discard!('b');

      expect(asked).toEqual(['b', 'b', 'b']);
      expect(await exists(directory)).toBe(false);
    });

    it("names the hosts of a session's repositories, and needs the session to", async () => {
      const hosts = createWorkspace({
        repositories: ({ sessionId }) => ({
          api: gitRepository({ url: 'https://github.com/acme/api.git' }),
          ...(sessionId !== 'a' && {
            web: gitRepository({ url: 'https://gitlab.com/acme/web.git' }),
          }),
        }),
      });

      expect(await hosts.hosts({ sessionId: 'a' })).toEqual(['github.com']);
      expect(await hosts.hosts({ sessionId: 'b' })).toEqual(['github.com', 'gitlab.com']);
      await expect(hosts.hosts()).rejects.toThrow(/per session/);
      await expect(perSession.hosts({ sessionId: 'b' })).resolves.toEqual([]);
      expect(asked).toEqual(['b']);
    });

    it('fails the start of a session whose repositories cannot be checked out side by side', async () => {
      const refused = createWorkspace({
        repositories: () => ({
          apps: sandboxRepository({ path: source }),
          'apps/web': sandboxRepository({ path: web }),
        }),
      });

      await expect(start('a', { workspace: refused })).rejects.toThrow(/within "apps"/);
    });

    it('fails the start of a session whose repositories cannot be had', async () => {
      const failing = createWorkspace({
        repositories: () => Promise.reject(new Error('Unknown project')),
      });

      await expect(start('a', { workspace: failing })).rejects.toThrow('Unknown project');
    });
  });

  describe('when something goes wrong', () => {
    it('stops a setup command that runs too long, unless the start itself is aborted', async () => {
      const slow = createWorkspace({
        source: sandboxRepository({ path: source }),
        setup: 'sleep 5',
        setupTimeoutMs: 100,
      });
      const timedOut = start('a', { workspace: slow });
      await expect(timedOut).rejects.toThrow(WorkspaceSetupError);
      await expect(timedOut).rejects.toMatchObject({ exitCode: -1 });

      const lease = slow.open({ sessionId: 'b', sandboxSession: host.sandbox });
      const directory = await sessionWorkDir(lease.sandboxSession, 'b');
      const controller = new AbortController();
      const starting = slow.onSession({
        session: lease.sandboxSession.restricted(),
        sessionWorkDir: directory,
        abortSignal: controller.signal,
      });
      setTimeout(() => controller.abort(), 50);
      await expect(starting).rejects.not.toThrow(WorkspaceSetupError);
    });

    it('refuses to reach the checkout of a session that is no longer live', async () => {
      const { lease } = await start('a');
      const session = workspace.session('a')!;
      await lease.suspend();

      await expect(session.changes()).rejects.toThrow(/no longer live/);
      await expect(session.changedFiles()).rejects.toThrow(WorkspaceError);
      await expect(session.run('true')).rejects.toThrow(WorkspaceError);
      await expect(session.writeLocalFile('a', 'b')).rejects.toThrow(WorkspaceError);
    });

    it("leaves a suspended session to its sandboxes' discard when its sandbox cannot be had", async () => {
      const discarded: string[] = [];
      const unavailable = (discard: boolean): SessionSandboxes => ({
        acquire: () => Promise.reject(new Error('no sandbox')),
        ...(discard && {
          discard: (sessionId: string) => {
            discarded.push(sessionId);
            return Promise.resolve();
          },
        }),
      });

      await workspace.sandboxes(unavailable(true)).discard!('a');
      expect(discarded).toEqual(['a']);
      await expect(workspace.sandboxes(unavailable(false)).discard!('a')).rejects.toThrow(
        'no sandbox',
      );
      expect(workspace.sandboxes(unavailable(false))).not.toHaveProperty('shutdown');
    });

    it('takes an abort signal at every step', async () => {
      const { signal } = new AbortController();
      const lease = workspace.open({ sessionId: 'a', sandboxSession: host.sandbox });
      const directory = await sessionWorkDir(lease.sandboxSession, 'a');
      await workspace.onSession({
        session: lease.sandboxSession.restricted(),
        sessionWorkDir: directory,
        abortSignal: signal,
      });
      const session = workspace.session('a')!;

      await session.writeLocalFile('local.txt', 'local', { abortSignal: signal });
      expect(await session.changedFiles({ abortSignal: signal })).toEqual([]);
      expect((await session.changes({ abortSignal: signal })).length).toBe(0);
      expect(
        (await session.run('echo ok', { abortSignal: signal, timeoutMs: 10_000 })).stdout,
      ).toBe('ok\n');

      await lease.suspend();
      expect(workspace.session('a')).toBeUndefined();
      const resumed = workspace.open({
        sessionId: 'a',
        sandboxSession: host.sandbox,
        resume: true,
      });
      await workspace.onSession({
        session: resumed.sandboxSession.restricted(),
        sessionWorkDir: directory,
      });
      expect(workspace.session('a')?.directory).toBe(directory);
    });

    it('says what git said when a step fails in the sandbox', async () => {
      const { lease } = await start('a');
      const failing = (pattern: string) =>
        ({
          ...host.sandbox,
          run: (options: { command: string }) =>
            options.command.includes(pattern)
              ? Promise.resolve({ exitCode: 7, stdout: '', stderr: 'fatal: broken' })
              : host.sandbox.run(options),
        }) as HarnessV1NetworkSandboxSession;

      const reattaching = workspace.open({
        sessionId: 'a',
        sandboxSession: failing('|| exit 2'),
        resume: true,
      });
      await expect(
        workspace.onSession({
          session: reattaching.sandboxSession.restricted(),
          sessionWorkDir: join(host.sandbox.defaultWorkingDirectory, 'claude-code-a'),
        }),
      ).rejects.toThrow(/reattach failed in the sandbox \(exit 7\): fatal: broken/);

      await lease.suspend();
      const listing = workspace.open({
        sessionId: 'a',
        sandboxSession: failing('--numstat'),
        resume: true,
      });
      await workspace.onSession({
        session: listing.sandboxSession.restricted(),
        sessionWorkDir: join(host.sandbox.defaultWorkingDirectory, 'claude-code-a'),
      });
      await expect(workspace.session('a')!.changedFiles()).rejects.toMatchObject({
        step: 'changes',
        stderr: 'fatal: broken',
      });
    });
  });
});
