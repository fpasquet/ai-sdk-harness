import type { HarnessV1RequestTransformation, HarnessV1SandboxTemplate } from '@ai-sdk/harness';

import { HarnessCapabilityUnsupportedError } from '@ai-sdk/harness';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FakeSbx } from '../../test/fake-sbx.js';

import { createFakeSbx } from '../../test/fake-sbx.js';
import {
  createSbxNetworkSandboxSession,
  resumeSbxNetworkSandboxSession,
  SbxSandboxNotFoundError,
} from '../index.js';
import { templateReference } from './sandbox-template.js';

/** What a harness asks for to keep an Anthropic token out of the sandbox. */
const anthropicTransformation = (placeholder: string): HarnessV1RequestTransformation => ({
  match: {
    host: 'api.anthropic.com',
    headers: [{ key: { exact: 'authorization' }, value: { exact: `Bearer ${placeholder}` } }],
  },
  transform: { headers: { authorization: 'Bearer real-token' } },
});

describe('createSbxNetworkSandboxSession', () => {
  let sbx: FakeSbx;

  beforeEach(() => {
    sbx = createFakeSbx();
  });
  afterEach(() => sbx.dispose());

  it('creates a shell sandbox and reads its working directory from it', async () => {
    const session = await createSbxNetworkSandboxSession({ binary: sbx.binary, sandboxId: 'box' });

    expect(session.id).toBe('box');
    expect(session.defaultWorkingDirectory).toBe(sbx.state().sandboxes.box?.root);
    expect(sbx.callsOf('create')).toEqual([['create', '--name', 'box', '--quiet', 'shell']]);
  });

  it('names the sandbox itself when no id is given', async () => {
    const session = await createSbxNetworkSandboxSession({ binary: sbx.binary });

    expect(session.id).toMatch(/^ai-sdk-[0-9a-f]{8}$/);
  });

  it('passes every creation setting to sbx create', async () => {
    await createSbxNetworkSandboxSession({
      binary: sbx.binary,
      sandboxId: 'box',
      agent: 'claude',
      image: 'my/image:1',
      workspace: '/repo',
      clone: true,
      readOnlyWorkspaces: ['/docs'],
      denyNetwork: ['github.com', '*.github.com'],
      cpus: 2,
      memory: '4g',
    });

    expect(sbx.callsOf('create')[0]).toEqual([
      'create',
      '--name',
      'box',
      '--quiet',
      '--template',
      'my/image:1',
      '--cpus',
      '2',
      '--memory',
      '4g',
      '--deny-network',
      'github.com',
      '--deny-network',
      '*.github.com',
      '--clone',
      'claude',
      '/repo',
      '/docs:ro',
    ]);
  });

  it('runs the setup commands as the sandbox user, in order', async () => {
    await createSbxNetworkSandboxSession({
      binary: sbx.binary,
      sandboxId: 'box',
      setup: ['echo one', 'echo two'],
    });

    const setup = sbx.callsOf('exec').filter((call) => call.at(-1)?.startsWith('echo'));
    expect(setup).toEqual([
      ['exec', 'box', 'sh', '-c', 'echo one'],
      ['exec', 'box', 'sh', '-c', 'echo two'],
    ]);
  });

  it('removes a half-made sandbox so a retry is not blocked', async () => {
    sbx.update((state) => state.failOn.push('echo broken'));

    await expect(
      createSbxNetworkSandboxSession({
        binary: sbx.binary,
        sandboxId: 'box',
        setup: ['echo broken'],
      }),
    ).rejects.toThrow(/failing on purpose/);
    expect(sbx.state().sandboxes).toEqual({});
  });

  it('never resumes: an existing sandbox of that name is a conflict', async () => {
    sbx.addSandbox('box');

    await expect(
      createSbxNetworkSandboxSession({ binary: sbx.binary, sandboxId: 'box' }),
    ).rejects.toThrow(/already exists/);
    expect(sbx.callsOf('create')).toEqual([]);
  });

  it.each(['a', '-box', 'default', 'with space', 'x/y'])(
    'rejects the sandbox id %j',
    async (id) => {
      await expect(
        createSbxNetworkSandboxSession({ binary: sbx.binary, sandboxId: id }),
      ).rejects.toThrow(/not a valid sandbox id/);
    },
  );

  it('refuses to clone without a workspace', async () => {
    await expect(
      createSbxNetworkSandboxSession({ binary: sbx.binary, sandboxId: 'box', clone: true }),
    ).rejects.toThrow(/`clone` needs a `workspace`/);
  });

  it('refuses to start once aborted', async () => {
    await expect(
      createSbxNetworkSandboxSession({ binary: sbx.binary, abortSignal: AbortSignal.abort() }),
    ).rejects.toThrow();
    expect(sbx.calls()).toEqual([]);
  });

  describe('with a template', () => {
    const template = (identity = 'recipe-1'): HarnessV1SandboxTemplate => ({
      identity,
      prepare: vi.fn(async ({ session }: Parameters<HarnessV1SandboxTemplate['prepare']>[0]) => {
        await session.writeTextFile({ path: 'prepared.txt', content: identity });
      }),
    });

    it('prepares a sandbox once, saves it as an image and starts every sandbox from it', async () => {
      const recipe = template();

      const first = await createSbxNetworkSandboxSession({
        binary: sbx.binary,
        sandboxId: 'first',
        template: recipe,
        setup: ['echo setup'],
      });
      const second = await createSbxNetworkSandboxSession({
        binary: sbx.binary,
        sandboxId: 'second',
        template: recipe,
        setup: ['echo setup'],
      });

      expect(recipe.prepare).toHaveBeenCalledTimes(1);
      const reference = templateReference({
        template: recipe,
        agent: 'shell',
        setup: ['echo setup'],
      });
      const { sandboxes, templates } = sbx.state();
      expect(templates).toEqual([
        { repository: 'docker.io/library/ai-sdk-harness-template', tag: reference.split(':')[1] },
      ]);
      expect(sandboxes.first?.template).toBe(reference);
      expect(sandboxes.second?.template).toBe(reference);
      // The builder sandbox is gone, and the setup ran in it only.
      expect(Object.keys(sandboxes).sort()).toEqual(['first', 'second']);
      expect(sbx.callsOf('exec').filter((call) => call.at(-1) === 'echo setup')).toHaveLength(1);
      expect(sbx.callsOf('create')[1]).toEqual(
        expect.arrayContaining(['--template', reference, '--pull', 'never']),
      );
      expect(first.id).toBe('first');
      expect(second.id).toBe('second');
    });

    it('reuses an image an earlier process built', async () => {
      const recipe = template('recipe-2');
      const [repository, tag] = templateReference({ template: recipe, agent: 'shell', setup: [] })
        .replace('docker.io/library/', '')
        .split(':');
      sbx.update((state) => {
        state.templates.push({ repository: `docker.io/library/${repository}`, tag: tag! });
      });

      await createSbxNetworkSandboxSession({
        binary: sbx.binary,
        sandboxId: 'box',
        template: recipe,
      });

      expect(recipe.prepare).not.toHaveBeenCalled();
    });

    it('gives another base an image of its own', () => {
      const recipe = template();

      expect(templateReference({ template: recipe, agent: 'shell', setup: [] })).not.toBe(
        templateReference({ template: recipe, agent: 'claude', setup: [] }),
      );
    });

    it('removes the builder sandbox when preparing fails, and builds again next time', async () => {
      const failing: HarnessV1SandboxTemplate = {
        identity: 'recipe-3',
        prepare: vi.fn().mockRejectedValueOnce(new Error('bootstrap failed')),
      };

      await expect(
        createSbxNetworkSandboxSession({ binary: sbx.binary, sandboxId: 'box', template: failing }),
      ).rejects.toThrow('bootstrap failed');
      expect(sbx.state().sandboxes).toEqual({});

      await createSbxNetworkSandboxSession({
        binary: sbx.binary,
        sandboxId: 'box',
        template: failing,
      });
      expect(failing.prepare).toHaveBeenCalledTimes(2);
    });
  });
});

describe('resumeSbxNetworkSandboxSession', () => {
  let sbx: FakeSbx;

  beforeEach(() => {
    sbx = createFakeSbx();
  });
  afterEach(() => sbx.dispose());

  it('reattaches to an existing sandbox', async () => {
    const root = sbx.addSandbox('box');

    const session = await resumeSbxNetworkSandboxSession({
      binary: sbx.binary,
      sandboxId: 'box',
      ports: [4000],
    });

    expect(session.id).toBe('box');
    expect(session.defaultWorkingDirectory).toBe(root);
    expect(session.ports).toEqual([4000]);
    expect(sbx.callsOf('create')).toEqual([]);
  });

  it('never creates one', async () => {
    const resuming = resumeSbxNetworkSandboxSession({ binary: sbx.binary, sandboxId: 'gone' });

    await expect(resuming).rejects.toBeInstanceOf(SbxSandboxNotFoundError);
    await expect(resuming).rejects.toMatchObject({ sandboxId: 'gone' });
  });

  it('refuses to start once aborted', async () => {
    await expect(
      resumeSbxNetworkSandboxSession({
        binary: sbx.binary,
        sandboxId: 'box',
        abortSignal: AbortSignal.abort(),
      }),
    ).rejects.toThrow();
  });
});

describe('SbxNetworkSandboxSession', () => {
  let sbx: FakeSbx;

  beforeEach(() => {
    sbx = createFakeSbx();
    sbx.addSandbox('box');
  });
  afterEach(() => sbx.dispose());

  const open = (settings: object | Parameters<typeof resumeSbxNetworkSandboxSession>[0] = {}) =>
    resumeSbxNetworkSandboxSession({ binary: sbx.binary, sandboxId: 'box', ...settings });

  describe('environment', () => {
    it('drops the proxy-managed credentials, and the variables named in clearEnv', async () => {
      const session = await open({ clearEnv: ['EXTRA'] });

      const { stdout } = await session.run({
        command: 'echo "[$ANTHROPIC_API_KEY][$GH_TOKEN][$EXTRA]"',
        env: { EXTRA: 'set-by-command' },
      });

      expect(stdout.trim()).toBe('[][][set-by-command]');
    });

    it('leaves the proxy-managed variables that hold no credential', async () => {
      const session = await open();

      const { stdout } = await session.run({ command: 'echo "$MCP_SENTINEL_TOKEN_NAME"' });

      expect(stdout.trim()).toBe('proxy-managed');
    });

    it('keeps them when asked to', async () => {
      const session = await open({ keepProxyManagedEnv: true });

      const { stdout } = await session.run({ command: 'echo "$ANTHROPIC_API_KEY"' });

      expect(stdout.trim()).toBe('proxy-managed');
    });

    it('rejects a clearEnv entry that is not a variable name', async () => {
      await expect(open({ clearEnv: ['NOT A NAME'] })).rejects.toThrow(/Not an environment/);
    });
  });

  describe('ports', () => {
    it('publishes an exposed port on the host loopback once, when first asked for', async () => {
      const session = await open({ ports: [4000] });

      const endpoint = await session.getPortEndpoint({ port: 4000, protocol: 'ws' });
      const url = await session.getPortUrl({ port: 4000 });

      expect(endpoint.url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/);
      expect(url).toBe(endpoint.url.replace('ws:', 'http:'));
      const hostPort = endpoint.url.split(':').at(-1);
      expect(sbx.state().ports).toEqual([{ name: 'box', binding: `127.0.0.1:${hostPort}:4000` }]);
    });

    it('refuses a port the sandbox does not expose', async () => {
      const session = await open({ ports: [4000] });

      await expect(session.getPortEndpoint({ port: 5000 })).rejects.toBeInstanceOf(
        HarnessCapabilityUnsupportedError,
      );
    });

    it('unpublishes the ports setPorts leaves out', async () => {
      const session = await open({ ports: [4000, 4001] });
      await session.getPortEndpoint({ port: 4000 });
      await session.getPortEndpoint({ port: 4001 });

      await session.setPorts([4001, 4002]);

      expect(session.ports).toEqual([4001, 4002]);
      expect(sbx.state().ports.map(({ binding }) => binding.split(':').at(-1))).toEqual(['4001']);
    });

    it('forgets a port that failed to publish, so the next call tries again', async () => {
      const session = await open({ ports: [4000] });
      sbx.update((state) => state.failOn.push('--publish'));

      await expect(session.getPortEndpoint({ port: 4000 })).rejects.toThrow();
      sbx.update((state) => (state.failOn = []));

      await expect(session.getPortEndpoint({ port: 4000 })).resolves.toMatchObject({
        url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:/) as string,
      });
    });
  });

  describe('credentials', () => {
    it('registers the part of the header that differs as a placeholder for the proxy', async () => {
      const session = await open();

      await session.addRequestTransformations?.([anthropicTransformation('placeholder-1')]);

      expect(sbx.state().secrets).toEqual([
        {
          scope: 'box',
          placeholder: 'placeholder-1',
          targets: ['api.anthropic.com'],
          value: 'real-token',
        },
      ]);
    });

    it('replaces every placeholder of the sandbox with setRequestTransformations', async () => {
      sbx.update((state) => {
        state.secrets.push(
          { scope: 'box', placeholder: 'stale', targets: ['x'], value: 'v' },
          { scope: 'other', placeholder: 'theirs', targets: ['x'], value: 'v' },
        );
      });
      const session = await open();

      await session.setRequestTransformations?.([anthropicTransformation('fresh')]);

      expect(sbx.state().secrets.map(({ placeholder }) => placeholder)).toEqual([
        'theirs',
        'fresh',
      ]);
    });

    it('cannot broker a header the request does not carry a placeholder in', async () => {
      const session = await open();

      await expect(
        session.addRequestTransformations?.([
          {
            match: { host: 'api.anthropic.com' },
            transform: { headers: { 'x-api-key': 'secret' } },
          },
        ]),
      ).rejects.toBeInstanceOf(HarnessCapabilityUnsupportedError);
    });

    it('leaves out, with a warning, a header the proxy would have to add', async () => {
      const session = await open();
      const warning = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
      const codex = anthropicTransformation('placeholder-2');

      await session.addRequestTransformations?.([
        {
          ...codex,
          transform: { headers: { ...codex.transform.headers, 'ChatGPT-Account-ID': 'acct' } },
        },
      ]);

      expect(sbx.state().secrets.map(({ placeholder }) => placeholder)).toEqual(['placeholder-2']);
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining('ChatGPT-Account-ID header of api.anthropic.com is left out'),
        { code: 'AI_SDK_SANDBOX_SBX_HEADER_LEFT_OUT' },
      );
      warning.mockRestore();
    });

    it('leaves brokering out when it is turned off', async () => {
      const session = await open({ brokerCredentials: false });

      expect(session.addRequestTransformations).toBeUndefined();
      expect(session.setRequestTransformations).toBeUndefined();
    });
  });

  describe('lifecycle', () => {
    it('releases its processes, ports and placeholders, and leaves the sandbox running', async () => {
      const session = await open({ ports: [4000] });
      await session.getPortEndpoint({ port: 4000 });
      await session.addRequestTransformations?.([anthropicTransformation('p')]);
      const running = await session.spawn({ command: 'sleep 30' });
      await new Promise((resolve) => setTimeout(resolve, 200));

      await session.release();

      expect((await running.wait()).exitCode).not.toBe(0);
      expect(sbx.state().ports).toEqual([]);
      expect(sbx.state().secrets).toEqual([]);
      expect(sbx.state().sandboxes.box?.status).toBe('running');
    });

    it('stops the processes a previous run left behind', async () => {
      const previous = await open();
      const orphan = await previous.spawn({ command: 'sleep 30' });
      await new Promise((resolve) => setTimeout(resolve, 200));
      const session = await open();

      await session.killAllProcesses();

      expect((await orphan.wait()).exitCode).not.toBe(0);
      expect((await session.run({ command: 'echo still works' })).stdout).toBe('still works\n');
    });

    it('stops the sandbox and keeps it', async () => {
      const session = await open();

      await session.stop();

      expect(sbx.state().sandboxes.box?.status).toBe('stopped');
    });

    it('destroys the sandbox', async () => {
      const session = await open();

      await session.destroy();
      await session.destroy();

      expect(sbx.state().sandboxes).toEqual({});
    });

    it('hands tools a restricted view of the same sandbox', async () => {
      const session = await open();
      const restricted = session.restricted();

      await restricted.writeTextFile({ path: 'shared.txt', content: 'same sandbox' });

      expect(await session.readTextFile({ path: 'shared.txt' })).toBe('same sandbox');
      expect('stop' in restricted).toBe(false);
    });
  });

  describe('fork', () => {
    it('gives a view of the same sandbox with ports of its own', async () => {
      const session = await open({ ports: [4000] });
      const view = session.fork({ ports: [4001] });

      await view.writeTextFile({ path: 'shared.txt', content: 'same microVM' });
      const endpoint = await view.getPortEndpoint({ port: 4001 });

      expect(view.id).toBe(session.id);
      expect(view.ports).toEqual([4001]);
      expect(await session.readTextFile({ path: 'shared.txt' })).toBe('same microVM');
      expect(endpoint.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      await expect(view.getPortEndpoint({ port: 4000 })).rejects.toBeInstanceOf(
        HarnessCapabilityUnsupportedError,
      );
    });

    it('releases its own processes, ports and placeholders, and nothing of the other views', async () => {
      const session = await open({ ports: [4000] });
      const view = session.fork({ ports: [4001] });
      await session.getPortEndpoint({ port: 4000 });
      await view.getPortEndpoint({ port: 4001 });
      await session.addRequestTransformations?.([anthropicTransformation('main')]);
      await view.addRequestTransformations?.([anthropicTransformation('view')]);
      const kept = await session.spawn({ command: 'sleep 30' });
      const stopped = await view.spawn({ command: 'sleep 30' });
      await new Promise((resolve) => setTimeout(resolve, 200));

      await view.release();

      expect((await stopped.wait()).exitCode).not.toBe(0);
      expect(sbx.state().ports.map(({ binding }) => binding.split(':').at(-1))).toEqual(['4000']);
      expect(sbx.state().secrets.map(({ placeholder }) => placeholder)).toEqual(['main']);
      await kept.kill();
    });

    it('replaces its own placeholders only with setRequestTransformations', async () => {
      const session = await open();
      const view = session.fork({ ports: [4001] });
      await session.addRequestTransformations?.([anthropicTransformation('main')]);
      await view.addRequestTransformations?.([anthropicTransformation('old')]);

      await view.setRequestTransformations?.([anthropicTransformation('new')]);

      expect(sbx.state().secrets.map(({ placeholder }) => placeholder)).toEqual(['main', 'new']);
    });

    it('keeps brokering off when the sandbox has it off', async () => {
      const session = await open({ brokerCredentials: false });

      expect(session.fork({ ports: [4001] }).addRequestTransformations).toBeUndefined();
    });
  });
});
