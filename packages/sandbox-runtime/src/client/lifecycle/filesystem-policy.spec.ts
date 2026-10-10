import { describe, expect, it } from 'vitest';

import type { SandboxRecord } from './sandbox-directory.js';

import { currentHost, environmentOf, filesystemOf, sandboxPath } from './filesystem-policy.js';
import { layoutOf, recordOf } from './sandbox-directory.js';

const host = {
  home: '/home/me',
  node: '/home/me/.nvm/versions/node/v24/bin/node',
  path: '/home/me/.local/bin:/usr/bin::/usr/bin',
  lang: 'fr_FR.UTF-8',
  user: 'me',
  srt: '/home/me/app/node_modules/@anthropic-ai/sandbox-runtime',
};
const layout = layoutOf('/home/me/.ai-sdk-sandbox-runtime', 'box');
const record = (settings: Parameters<typeof recordOf>[0] = {}): SandboxRecord => recordOf(settings);

describe('filesystemOf', () => {
  it('hides the home but for what the sandbox needs, and only lets it write its own directory', () => {
    const filesystem = filesystemOf(
      layout,
      record({ readOnlyWorkspaces: ['/srv/docs', '/home/me/lib'], denyRead: ['/etc/secret'] }),
      host,
    );

    expect(filesystem.denyRead).toEqual(['/home/me', '/etc/secret']);
    expect(filesystem.allowRead).toEqual([
      '/home/me/.ai-sdk-sandbox-runtime/box/sandbox',
      '/home/me/.ai-sdk-sandbox-runtime/box/.supervisor',
      '/home/me/lib',
      '/home/me/.nvm/versions/node/v24',
      '/home/me/app/node_modules/@anthropic-ai/sandbox-runtime',
      '/home/me/.ai-sdk-sandbox-runtime/box/sandbox/home/.local/bin',
      '/home/me/.nvm/versions/node/v24/bin',
      '/home/me/.local/bin',
    ]);
    expect(filesystem.allowWrite).toEqual(['/home/me/.ai-sdk-sandbox-runtime/box/sandbox']);
    expect(filesystem.denyWrite).toEqual([]);
  });

  it('adds the workspace to what it writes, and leaves the home alone when told', () => {
    const filesystem = filesystemOf(
      layout,
      record({
        workspace: '/home/me/project',
        hideHome: false,
        allowRead: ['/opt/tool'],
        allowWrite: ['/var/cache/x'],
        denyWrite: ['/home/me/project/.git'],
      }),
      host,
    );

    expect(filesystem.denyRead).toEqual([]);
    expect(filesystem.allowRead).toEqual(['/opt/tool']);
    expect(filesystem.allowWrite).toEqual([
      '/home/me/.ai-sdk-sandbox-runtime/box/sandbox',
      '/home/me/project',
      '/var/cache/x',
    ]);
    expect(filesystem.denyWrite).toEqual(['/home/me/project/.git']);
  });
});

describe('the environment of a sandbox', () => {
  it("puts the sandbox's global installs, then Node.js, before the host's PATH", () => {
    expect(sandboxPath(layout, host)).toBe(
      '/home/me/.ai-sdk-sandbox-runtime/box/sandbox/home/.local/bin:/home/me/.nvm/versions/node/v24/bin:/home/me/.local/bin:/usr/bin',
    );
  });

  it('keeps nothing of the host but its locale, its user and its PATH', () => {
    expect(environmentOf(layout, host)).toEqual({
      PATH: sandboxPath(layout, host),
      HOME: layout.home,
      TMPDIR: layout.tmpdir,
      NPM_CONFIG_PREFIX: `${layout.home}/.local`,
      COREPACK_DEFAULT_TO_LATEST: '0',
      COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
      LANG: 'fr_FR.UTF-8',
      USER: 'me',
      SHELL: '/bin/sh',
    });
    expect(environmentOf(layout, { ...host, lang: undefined, user: undefined })).toMatchObject({
      LANG: 'C.UTF-8',
    });
  });

  it('reads the host from the environment it is given', () => {
    expect(currentHost({ PATH: '/bin', LANG: 'C', USER: 'u' })).toMatchObject({
      path: '/bin',
      lang: 'C',
      user: 'u',
      node: process.execPath,
    });
    expect(currentHost({}).srt).toMatch(/@anthropic-ai[/+]sandbox-runtime/);
    expect(currentHost({})).not.toHaveProperty('lang');
    expect(currentHost({}).path).toBe('/usr/local/bin:/usr/bin:/bin');
  });
});
