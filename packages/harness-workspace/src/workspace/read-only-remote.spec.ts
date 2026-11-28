import type { HarnessV1NetworkSandboxSession } from '@ai-sdk/harness';

import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { HostSandbox } from '../../test/host-sandbox.js';
import type {
  SessionSandboxes,
  SingleRepositoryWorkspaceSession,
  Workspace,
} from '../definitions/workspace.js';
import type { GitCredentials } from '../sources/git-repository.js';

import {
  createHostSandbox,
  createSourceRepository,
  git,
  sessionWorkDir,
} from '../../test/host-sandbox.js';
import { WorkspaceError } from '../errors/workspace-error.js';
import { gitRepository } from '../sources/git-repository.js';
import { createWorkspace } from './create-workspace.js';
import { withWorkspace } from './with-workspace.js';

const URL_OF_SERVER = 'https://git.example.com/acme/widgets.git';
const basic = (credentials: string) => `Basic ${Buffer.from(credentials).toString('base64')}`;

/** Sandboxes that give every session the one stand-in sandbox. */
function hostSandboxes(sandbox: HarnessV1NetworkSandboxSession): SessionSandboxes {
  return {
    capacity: 4,
    acquire: () =>
      Promise.resolve({
        sandboxSession: sandbox,
        suspend: () => Promise.resolve(),
        close: () => Promise.resolve(),
      }),
  };
}

/** Every file under `directory`, with what it holds. */
async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async (entry) => readFile(join(entry.parentPath, entry.name), 'latin1')),
  );
}

describe('the read-only remote of gitRepository()', () => {
  let source: string;

  beforeEach(async () => {
    source = await createSourceRepository();
    await git(source, 'checkout', '--quiet', '-b', 'feature');
    await writeFile(join(source, 'feature.txt'), 'feature\n');
    await git(source, 'add', '.');
    await git(source, 'commit', '--quiet', '-m', 'Feature');
    await git(source, 'checkout', '--quiet', 'main');
  });

  /** Starts session `id` of `workspace` in `host`, as the session manager and the harness would. */
  async function start(
    host: HostSandbox,
    workspace: Workspace<SingleRepositoryWorkspaceSession>,
    id: string,
    { resume = false }: { resume?: boolean } = {},
  ) {
    const lease = await workspace.sandboxes(hostSandboxes(host.sandbox)).acquire(id, { resume });
    const directory = await sessionWorkDir(lease.sandboxSession, id);
    const settings = withWorkspace({ harness: { harnessId: 'claude-code' } }, workspace);
    await settings.sandboxConfig.onSession!({
      session: lease.sandboxSession.restricted(),
      sessionWorkDir: directory,
    });
    return { lease, directory };
  }

  /** Runs `command` in the sandbox, in `directory`: what the agent would. */
  async function run(host: HostSandbox, directory: string, command: string): Promise<string> {
    const { exitCode, stdout, stderr } = await host.sandbox.run({
      command,
      workingDirectory: directory,
    });
    if (exitCode !== 0) throw new Error(`${command} failed: ${stderr}`);
    return stdout.trim();
  }

  it('gives a public repository an origin remote, its branches fetched, for the agent to fetch, rebase and check out', async () => {
    const host = await createHostSandbox();
    const url = pathToFileURL(source).href;
    const workspace = createWorkspace({
      source: gitRepository({ url, readOnlyRemote: true }),
      branch: () => 'fix/login',
    });

    const { directory } = await start(host, workspace, 'a');

    expect(await run(host, directory, 'git remote get-url origin')).toBe(url);
    expect(await run(host, directory, 'git branch --show-current')).toBe('fix/login');
    expect(
      await run(host, directory, 'git for-each-ref --format="%(refname)" refs/remotes/origin'),
    ).toBe('refs/remotes/origin/feature\nrefs/remotes/origin/main');
    // Work goes on upstream: the agent fetches it, and rebases on it.
    await writeFile(join(source, 'upstream.txt'), 'upstream\n');
    await git(source, 'add', '.');
    await git(source, 'commit', '--quiet', '-m', 'Upstream');
    await writeFile(join(directory, 'mine.txt'), 'mine\n');
    await run(host, directory, 'git add . && git commit --quiet -m Mine');
    await run(host, directory, 'git fetch --quiet');
    await run(host, directory, 'git rebase --quiet origin/main');
    expect(await run(host, directory, 'git log --format=%s -3')).toBe('Mine\nUpstream\nSecond');
    await run(host, directory, 'git checkout --quiet -b other origin/feature');
    expect(await readFile(join(directory, 'feature.txt'), 'utf8')).toBe('feature\n');
    expect(await run(host, directory, 'git ls-remote --heads origin')).toContain(
      'refs/heads/feature',
    );
    // No credential, so no header in any configuration.
    expect(await run(host, directory, 'git config --get-regexp extraheader || true')).toBe('');
    expect(host.transformations).toEqual([]);
  });

  describe('of a private repository', () => {
    let server: string;
    let gitConfig: string;
    let tokens: string[];
    let credentials: () => Promise<GitCredentials>;

    beforeEach(async () => {
      // The Git server: a bare clone of the source, at the path of the repository's URL. The
      // sandbox routes git to it the way ai-sdk-sandbox-gce routes git to its proxy.
      const root = await mkdtemp(join(tmpdir(), 'harness-workspace-server-'));
      server = join(root, 'acme');
      await mkdir(server);
      await git(server, 'clone', '--quiet', '--bare', source, 'widgets.git');
      gitConfig = join(root, 'gitconfig');
      await writeFile(
        gitConfig,
        `[url "${pathToFileURL(root).href}/"]\n\tinsteadOf = https://git.example.com/\n`,
      );
      tokens = [];
      credentials = () => {
        const token = `ghs_token_${tokens.length + 1}`;
        tokens.push(token);
        return Promise.resolve({ token });
      };
    });

    const routed = () => `${pathToFileURL(server).href}/widgets.git`;

    it('keeps only a placeholder of the session in its checkout, and brokers the token for reads alone', async () => {
      const host = await createHostSandbox({
        credentialBrokering: { scope: 'request' },
        gitConfig,
      });
      const workspace = createWorkspace({
        source: gitRepository({ url: URL_OF_SERVER, credentials, readOnlyRemote: true }),
      });

      const first = await start(host, workspace, 'a');
      const second = await start(host, workspace, 'b');

      const header = (directory: string, url: string) =>
        run(host, directory, `git config --get "http.${url}.extraHeader"`);
      const placeholderOf = async (directory: string) => {
        const value = await header(directory, URL_OF_SERVER);
        expect(await header(directory, routed())).toBe(value);
        return value.replace(/^Authorization: /, '');
      };
      const firstPlaceholder = await placeholderOf(first.directory);
      const secondPlaceholder = await placeholderOf(second.directory);
      // Each session has a placeholder of its own, in its checkout's configuration alone.
      expect(firstPlaceholder).not.toBe(secondPlaceholder);
      expect(Buffer.from(firstPlaceholder.slice('Basic '.length), 'base64').toString()).toMatch(
        /^x-access-token:ai-sdk-harness-[0-9a-f-]{36}$/,
      );
      const repository = join(host.home, '.ai-sdk-harness/repositories/widgets.git');
      expect(await readFile(join(repository, 'config'), 'utf8')).not.toMatch(/extraheader/i);
      expect(await run(host, first.directory, 'git remote get-url origin')).toBe(routed());
      expect(await git(repository, 'config', 'remote.origin.url')).toBe(URL_OF_SERVER);
      await run(host, first.directory, 'git fetch --quiet origin');
      await run(host, first.directory, 'git checkout --quiet -b x origin/feature');

      // The rules: the exact paths of a read, on the exact host, for the session's placeholder.
      const remoteRules = host.transformations.filter(({ match }) =>
        match.headers?.some(
          ({ value }) => value && 'exact' in value && value.exact === firstPlaceholder,
        ),
      );
      expect(remoteRules.map(({ match }) => match)).toEqual(
        ['/acme/widgets', '/acme/widgets.git'].flatMap((path) => [
          {
            host: 'git.example.com',
            path: { exact: `${path}/info/refs` },
            method: ['GET'],
            queryString: [{ key: { exact: 'service' }, value: { exact: 'git-upload-pack' } }],
            headers: [{ key: { exact: 'Authorization' }, value: { exact: firstPlaceholder } }],
          },
          {
            host: 'git.example.com',
            path: { exact: `${path}/git-upload-pack` },
            method: ['POST'],
            headers: [{ key: { exact: 'Authorization' }, value: { exact: firstPlaceholder } }],
          },
        ]),
      );
      expect(JSON.stringify(host.transformations)).not.toContain('receive-pack');
      expect(
        host.transformations.every(
          ({ match }) => match.path !== undefined && 'exact' in match.path,
        ),
      ).toBe(true);

      // The token is nowhere in the sandbox: no file, no command, no variable.
      const sandboxFiles = (await filesUnder(host.directory)).join('\n');
      for (const token of tokens) {
        for (const form of [token, basic(`x-access-token:${token}`)]) {
          expect(sandboxFiles).not.toContain(form);
          expect(JSON.stringify(host.commands)).not.toContain(form);
        }
      }
    });

    it('renews the token for the same placeholder, at an interval, on demand and at a resume, until the session is suspended', async () => {
      const host = await createHostSandbox({
        credentialBrokering: { scope: 'request' },
        gitConfig,
      });
      const workspace = createWorkspace({
        source: gitRepository({
          url: URL_OF_SERVER,
          credentials,
          readOnlyRemote: { refreshIntervalMs: 20 },
        }),
      });
      const { lease, directory } = await start(host, workspace, 'a');
      const placeholder = (
        await run(host, directory, `git config --get "http.${URL_OF_SERVER}.extraHeader"`)
      ).replace(/^Authorization: /, '');
      const rulesFor = (value: string) =>
        host.transformations.filter(({ match }) =>
          match.headers?.some(
            (header) => header.value && 'exact' in header.value && header.value.exact === value,
          ),
        );

      await vi.waitFor(() => expect(rulesFor(placeholder).length).toBeGreaterThanOrEqual(12));
      await workspace.session('a')!.refreshCredentials();

      // Each renewal registers the same four rules again, the placeholder unchanged: a sandbox
      // whose brokering matches whole requests replaces them, the new token with them.
      const rules = rulesFor(placeholder);
      expect(rules.length % 4).toBe(0);
      const first = rules.slice(0, 4).map(({ match }) => match);
      for (let index = 0; index < rules.length; index += 4) {
        expect(rules.slice(index, index + 4).map(({ match }) => match)).toEqual(first);
      }
      expect(rules.at(-1)!.transform.headers.Authorization).toBe(
        basic(`x-access-token:${tokens.at(-1)!}`),
      );

      await lease.suspend();
      const asked = tokens.length;
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(tokens.length).toBe(asked);

      // A resume asks for a token again, with a new placeholder in the checkout.
      const again = await start(host, workspace, 'a', { resume: true });
      const resumed = (
        await run(host, directory, `git config --get "http.${URL_OF_SERVER}.extraHeader"`)
      ).replace(/^Authorization: /, '');
      expect(resumed).not.toBe(placeholder);
      expect(rulesFor(resumed)).toHaveLength(4);
      expect(tokens.length).toBe(asked + 1);
      await again.lease.close();
    });

    it.each([
      ['matches the host alone', { scope: 'host' }],
      ['says nothing of its brokering', undefined],
    ])('refuses a sandbox that %s, before the token is brokered', async (_, brokering) => {
      const host = await createHostSandbox({
        gitConfig,
        ...(brokering !== undefined && { credentialBrokering: brokering }),
      });
      const workspace = createWorkspace({
        source: gitRepository({ url: URL_OF_SERVER, credentials, readOnlyRemote: true }),
      });

      const starting = start(host, workspace, 'a');

      await expect(starting).rejects.toThrow(WorkspaceError);
      await expect(starting).rejects.toThrow(/could push with the token/);
      expect(host.transformations).toEqual([]);
      expect(host.commands.some(({ command }) => command.includes(' fetch '))).toBe(false);
    });

    it('still fetches the checkout alone, without a remote, on any brokering sandbox', async () => {
      const host = await createHostSandbox({ gitConfig });
      const workspace = createWorkspace({
        source: gitRepository({ url: URL_OF_SERVER, credentials }),
      });

      const { directory } = await start(host, workspace, 'a');

      expect(await run(host, directory, 'git remote')).toBe('');
      expect(await run(host, directory, 'git config --get-regexp extraheader || true')).toBe('');
      expect(host.transformations).toHaveLength(4);
    });
  });

  it('refuses a refresh interval that is no positive integer', () => {
    expect(() =>
      gitRepository({ url: URL_OF_SERVER, readOnlyRemote: { refreshIntervalMs: 0 } }),
    ).toThrow(TypeError);
  });
});
