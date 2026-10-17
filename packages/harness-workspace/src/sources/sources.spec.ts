import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';

import type { HostSandbox } from '../../test/host-sandbox.js';
import type { WorkspaceSource } from '../definitions/source.js';

import { createHostSandbox, createSourceRepository, git } from '../../test/host-sandbox.js';
import { WorkspaceError } from '../errors/workspace-error.js';
import { initRepository } from '../git/repository.js';
import { gitRepository } from './git-repository.js';
import { hostRepository } from './host-repository.js';
import { sandboxRepository } from './sandbox-repository.js';

const COMMITTER = { name: 'Agent', email: 'agent@example.com' };

describe('workspace sources', () => {
  let host: HostSandbox;
  let source: string;
  let repository: string;

  beforeEach(async () => {
    host = await createHostSandbox();
    source = await createSourceRepository();
    repository = join(host.home, 'repository.git');
    await initRepository(host.sandbox, { repository, committer: COMMITTER });
  });

  const fetch = (from: WorkspaceSource, ref = 'refs/ai-sdk-harness/fetched/a') =>
    from.fetch({ sandbox: host.sandbox, repository, ref, sessionId: 'a' });

  describe('gitRepository', () => {
    it('fetches a revision of the repository at a URL', async () => {
      await writeFile(join(source, 'feature.txt'), 'feature\n');
      await git(source, 'checkout', '--quiet', '-b', 'feature');
      await git(source, 'add', '.');
      await git(source, 'commit', '--quiet', '-m', 'Feature');
      await git(source, 'checkout', '--quiet', 'main');

      await fetch(gitRepository({ url: pathToFileURL(source).href }), 'refs/x/head');
      await fetch(
        gitRepository({ url: pathToFileURL(source).href, ref: 'feature', depth: 1 }),
        'refs/x/feature',
      );

      expect(await git(repository, 'rev-parse', 'refs/x/head')).toBe(
        await git(source, 'rev-parse', 'main'),
      );
      expect(await git(repository, 'rev-parse', 'refs/x/feature')).toBe(
        await git(source, 'rev-parse', 'feature'),
      );
      expect(gitRepository({ url: 'https://github.com/acme/widgets.git' }).name).toBe('widgets');
    });

    it('keeps the credential out of the sandbox: the broker gets it, git sends a placeholder', async () => {
      const from = gitRepository({
        url: 'https://git.example.com/acme/widgets.git',
        credentials: () => Promise.resolve({ token: 'real-token' }),
      });

      // No such server: the fetch fails, after the credential is brokered.
      await expect(fetch(from)).rejects.toThrow(WorkspaceError);

      const [transformation] = host.transformations;
      const placeholder = transformation!.match.headers![0]!.value as { exact: string };
      expect(transformation).toMatchObject({
        match: { host: 'git.example.com', path: { startsWith: '/acme/widgets' } },
        transform: {
          headers: {
            Authorization: `Basic ${Buffer.from('x-access-token:real-token').toString('base64')}`,
          },
        },
      });
      expect(Buffer.from(placeholder.exact.slice('Basic '.length), 'base64').toString()).toMatch(
        /^x-access-token:ai-sdk-harness-[0-9a-f-]{36}$/,
      );
      const fetchCommand = host.commands.find(({ env }) => env.GIT_CONFIG_COUNT === '1')!;
      expect(fetchCommand.env).toMatchObject({
        GIT_CONFIG_KEY_0: 'http.extraHeader',
        GIT_CONFIG_VALUE_0: `Authorization: ${placeholder.exact}`,
      });
      expect(JSON.stringify(host.commands)).not.toContain('real-token');
      expect(JSON.stringify(host.commands)).not.toContain(
        Buffer.from('x-access-token:real-token').toString('base64'),
      );
    });

    it('refuses to fetch with a credential from a sandbox that cannot broker it', async () => {
      host = await createHostSandbox({ brokering: false });
      await initRepository(host.sandbox, { repository, committer: COMMITTER });

      await expect(
        fetch(
          gitRepository({
            url: 'https://git.example.com/a.git',
            credentials: { username: 'oauth2', token: 't' },
          }),
        ),
      ).rejects.toThrow(/no credential brokering/);
      expect(host.commands.some(({ command }) => command.includes('fetch'))).toBe(false);
    });

    it('refuses what it cannot fetch safely', () => {
      expect(() => gitRepository({ url: 'ssh://git@example.com/a.git' })).toThrow(TypeError);
      expect(() => gitRepository({ url: 'https://user:secret@example.com/a.git' })).toThrow(
        TypeError,
      );
      expect(() =>
        gitRepository({ url: 'http://example.com/a.git', credentials: { token: 't' } }),
      ).toThrow(/https/);
      expect(() =>
        gitRepository({ url: 'https://example.com/a.git', ref: '--upload-pack=x' }),
      ).toThrow(TypeError);
      expect(() => gitRepository({ url: 'https://example.com/a.git', depth: 0 })).toThrow(
        TypeError,
      );
    });
  });

  describe('sandboxRepository', () => {
    it('fetches from a repository already in the sandbox', async () => {
      await fetch(sandboxRepository({ path: source, ref: 'main' }));

      expect(await git(repository, 'rev-parse', 'refs/ai-sdk-harness/fetched/a')).toBe(
        await git(source, 'rev-parse', 'main'),
      );
      expect(() => sandboxRepository({ path: 'relative' })).toThrow(TypeError);
    });
  });

  describe('hostRepository', () => {
    it('sends a bundle of what the sandbox lacks, and nothing when it has it all', async () => {
      const from = hostRepository({ path: source });

      await fetch(from, 'refs/ai-sdk-harness/base/a');
      expect(await git(repository, 'rev-parse', 'refs/ai-sdk-harness/base/a')).toBe(
        await git(source, 'rev-parse', 'HEAD'),
      );
      expect(host.written).toHaveLength(1);

      // Nothing new on this host: no bundle.
      await fetch(from, 'refs/ai-sdk-harness/base/b');
      expect(host.written).toHaveLength(1);

      // A new commit: a bundle of it alone, the sandbox's commits left out.
      await writeFile(join(source, 'index.js'), 'export const answer = 42;\n');
      await git(source, 'commit', '--quiet', '-am', 'Third');
      await fetch(from, 'refs/ai-sdk-harness/base/c');
      expect(await git(repository, 'rev-parse', 'refs/ai-sdk-harness/base/c')).toBe(
        await git(source, 'rev-parse', 'HEAD'),
      );
      expect(host.written).toHaveLength(2);
      const bundled = host.commands.filter(({ command }) => command.includes('.bundle'));
      expect(bundled.length).toBeGreaterThan(0);
      // The bundles are removed from the sandbox once fetched.
      expect((await readdir(repository)).filter((name) => name.endsWith('.bundle'))).toEqual([]);
    });

    it('refuses what a bundle cannot carry', () => {
      expect(() => hostRepository({ path: source, ref: 'a'.repeat(40) })).toThrow(
        /branch or a tag/,
      );
      expect(() => hostRepository({ path: 'relative' })).toThrow(TypeError);
    });

    it('says when git fails on this host', async () => {
      await expect(fetch(hostRepository({ path: source, ref: 'missing' }))).rejects.toThrow(
        /failed on this host/,
      );
    });
  });
});
