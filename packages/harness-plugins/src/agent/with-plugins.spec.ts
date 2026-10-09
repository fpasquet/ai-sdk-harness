import { createClaudeCode } from '@ai-sdk/harness-claude-code';
import { createCodex } from '@ai-sdk/harness-codex';
import { HarnessAgent } from '@ai-sdk/harness/agent';
import { tool } from '@ai-sdk/provider-utils';
import { execFileSync } from 'node:child_process';
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { HostSandbox } from '../../test/host-sandbox.js';
import type { Plugin } from '../definitions/plugin.js';
import type { PluginAgentSettings } from './with-plugins.js';

import { createHostSandbox } from '../../test/host-sandbox.js';
import { resolvePlugins } from '../config/resolve-plugins.js';
import { InvalidPluginError } from '../errors/invalid-plugin-error.js';
import { pluginHarnessSettings } from './plugin-harness-settings.js';
import { withPlugins } from './with-plugins.js';

const claudeCode = createClaudeCode();
const codex = createCodex();

const echo = tool({
  description: 'Echo',
  inputSchema: z.object({ text: z.string() }),
  execute: ({ text }) => text,
});

const guard: Plugin = {
  name: 'guard',
  description: 'Guards the shell.',
  hooks: [
    { event: 'PreToolUse', matcher: 'Bash', command: '"${PLUGIN_ROOT}/guard.sh"', timeout: 5 },
    { event: 'Stop', prompt: 'Is the work done?' },
  ],
  files: [{ path: 'guard.sh', content: '#!/bin/sh\nexit 0\n', executable: true }],
};

const reviewer: Plugin = {
  name: 'reviewer',
  description: 'Reviews.',
  tools: { echo },
  skills: [{ name: 'review-style', description: 'How to review.', content: 'Be kind.' }],
  rules: [
    { name: 'tone', content: 'Be brief.' },
    { name: 'tests', paths: ['src/**/*.ts'], content: 'Write a test for each change.' },
  ],
  subagents: [
    {
      name: 'critic',
      description: 'Criticises.',
      instructions: 'Find the flaws.',
      tools: ['Read'],
      model: 'haiku',
    },
  ],
};

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

describe('withPlugins', () => {
  it('adds the tools and skills of the plugins to the agent', () => {
    const own = tool({ description: 'Own', inputSchema: z.object({}), execute: () => 'own' });
    const settings = withPlugins(
      {
        harness: claudeCode,
        instructions: 'Be helpful.',
        tools: { own },
        skills: [{ name: 'own-skill', description: '', content: '' }],
      },
      [reviewer],
    );
    expect(settings.instructions).toBe('Be helpful.');
    expect(Object.keys(settings.tools)).toEqual(['own', 'echo']);
    expect(settings.skills.map(({ name }) => name)).toEqual(['own-skill', 'review-style']);
    expect(settings).not.toHaveProperty('activeTools');
    expect(typeof settings.sandboxConfig?.onSession).toBe('function');
  });

  it('leaves tools and skills out when nobody has any', () => {
    const settings = withPlugins({ harness: claudeCode }, [guard]);
    expect(settings).not.toHaveProperty('tools');
    expect(settings).not.toHaveProperty('skills');
  });

  it('lets the tools of the plugins, and the skill tool, through an allow-list', () => {
    const settings = withPlugins({ harness: claudeCode, activeTools: ['Read', 'Read'] as const }, [
      reviewer,
    ]);
    expect(settings.activeTools).toEqual(['Read', 'echo', 'Skill']);
    const codexSettings = withPlugins({ harness: codex, activeTools: [] }, [reviewer], {
      onUnsupported: () => undefined,
    });
    expect(codexSettings.activeTools).toEqual(['echo']);
  });

  it('refuses a tool named like one of the runtime, of the agent or of another plugin', () => {
    const bash: Plugin = { name: 'bash', description: '', tools: { bash: echo } };
    expect(() => withPlugins({ harness: claudeCode }, [bash])).toThrow(
      'Plugin "bash": its tool "bash" has the name of the runtime\'s own bash.',
    );
    expect(() => withPlugins({ harness: claudeCode, tools: { echo } }, [reviewer])).toThrow(
      'has the name of a tool of the agent.',
    );
    const twin: Plugin = { name: 'twin', description: '', tools: { echo } };
    expect(() => withPlugins({ harness: claudeCode }, [reviewer, twin])).toThrow(
      'its tool "echo" has the name of a tool of plugin "reviewer".',
    );
  });

  it('refuses a skill named like one of the agent or of another plugin', () => {
    const skill = { name: 'review-style', description: '', content: '' };
    expect(() => withPlugins({ harness: claudeCode, skills: [skill] }, [reviewer])).toThrow(
      InvalidPluginError,
    );
    const twin: Plugin = { name: 'twin', description: '', skills: [skill] };
    expect(() => withPlugins({ harness: claudeCode }, [reviewer, twin])).toThrow(
      'its skill "review-style" has the name of a skill of plugin "reviewer".',
    );
  });

  it('reports what the runtime cannot take, as a process warning by default', () => {
    const onUnsupported = vi.fn();
    const servers: Plugin = {
      name: 'servers',
      description: '',
      mcpServers: { a: { type: 'stdio', command: 'a', runIn: 'sandbox' } },
    };
    withPlugins({ harness: codex }, [guard, reviewer, servers], { onUnsupported });
    expect(onUnsupported.mock.calls).toEqual([
      [{ plugin: 'guard', feature: 'hooks', harnessId: 'codex' }],
      [{ plugin: 'reviewer', feature: 'subagents', harnessId: 'codex' }],
    ]);
    const unknown = { harnessId: 'opencode', builtinTools: {} };
    withPlugins({ harness: unknown }, [servers], { onUnsupported });
    expect(onUnsupported).toHaveBeenLastCalledWith({
      plugin: 'servers',
      feature: 'mcpServers',
      harnessId: 'opencode',
    });

    const emitWarning = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    withPlugins({ harness: codex }, [guard]);
    expect(emitWarning).toHaveBeenCalledWith(
      'Plugin "guard": codex does not support hooks; they are left out.',
      'AiSdkHarnessPluginsWarning',
    );
    emitWarning.mockRestore();
  });

  it('builds the tools written as configuration, and refuses one that needs resolving', () => {
    const api: Plugin = {
      name: 'api',
      description: '',
      tools: {
        count: { type: 'sandbox-command', description: 'Count', command: 'wc -l' },
        status: { type: 'http', description: 'Status', url: 'https://api.example.com/status' },
      },
    };
    const settings = withPlugins({ harness: claudeCode }, [api]);
    expect(Object.keys(settings.tools ?? {})).toEqual(['count', 'status']);
    expect(typeof (settings.tools?.status as { execute?: unknown }).execute).toBe('function');
    const secret: Plugin = {
      name: 'secret',
      description: '',
      tools: {
        call: {
          type: 'http',
          description: 'Call',
          url: 'https://api.example.com',
          headers: { Authorization: { secret: 'TOKEN' } },
        },
      },
    };
    expect(() => withPlugins({ harness: claudeCode }, [secret])).toThrow(
      'Plugin "secret": its tool "call" refers to a secret or a tool of your application: resolve the plugins with resolvePlugins() first.',
    );
  });

  it('takes resolved plugins, their servers run in the sandbox included', async () => {
    const box: Plugin = {
      name: 'box',
      description: '',
      mcpServers: { local: { type: 'stdio', command: 'node', args: ['s.mjs'], runIn: 'sandbox' } },
    };
    const { plugins } = await resolvePlugins([box]);
    expect(() => withPlugins({ harness: claudeCode }, plugins)).not.toThrow();
    expect(pluginHarnessSettings('claude-code', plugins).mcpServers).toEqual({
      local: { type: 'stdio', command: 'node', args: ['s.mjs'], env: {} },
    });
    const toConnect: Plugin = {
      name: 'docs',
      description: '',
      mcpServers: { docs: { type: 'http', url: 'https://docs.example.com' } },
    };
    expect(() => withPlugins({ harness: claudeCode }, [toConnect])).toThrow(
      'Plugin "docs": its MCP server "docs" is connected by your server: resolve the plugins with resolvePlugins() first.',
    );
  });

  it('gives the rules to a runtime without rules of its own in its instructions, after the agent own', () => {
    const rules =
      '# Rules\n\nFollow these rules of the project.\n\n## tone\n\nBe brief.\n\n## tests\n\nOnly for the files matching `src/**/*.ts`.\n\nWrite a test for each change.';
    const options = { onUnsupported: () => undefined };
    expect(withPlugins({ harness: codex }, [reviewer], options).instructions).toBe(rules);
    expect(
      withPlugins({ harness: codex, instructions: 'Be careful.' }, [reviewer], options)
        .instructions,
    ).toBe(`Be careful.\n\n${rules}`);
    expect(
      withPlugins(
        { harness: codex, instructions: { role: 'system', content: 'Be careful.' } },
        [reviewer],
        options,
      ).instructions,
    ).toEqual({ role: 'system', content: `Be careful.\n\n${rules}` });
    // Claude Code reads them from files: its instructions stay as they are.
    expect(
      withPlugins({ harness: claudeCode, instructions: 'Be careful.' }, [reviewer]).instructions,
    ).toBe('Be careful.');
    expect(withPlugins({ harness: codex }, [guard], options).instructions).toBeUndefined();
  });

  it('builds a HarnessAgent', () => {
    const agent = new HarnessAgent(
      withPlugins({ harness: claudeCode, instructions: 'Hi' }, [guard, reviewer]),
    );
    expect(agent.id).toBeUndefined();
  });
});

describe('the session files', () => {
  let sandbox: HostSandbox;
  const onSession = async (
    plugins: Plugin[],
    harness: PluginAgentSettings['harness'] = claudeCode,
    own?: () => Promise<void>,
  ) => {
    const settings = withPlugins({ harness, sandboxConfig: { onSession: own } }, plugins, {
      onUnsupported: () => undefined,
    });
    await settings.sandboxConfig.onSession?.({
      session: sandbox.session,
      sessionWorkDir: sandbox.directory,
    });
  };
  const read = (path: string) => readFile(join(sandbox.directory, path), 'utf8');

  beforeEach(async () => {
    sandbox = await createHostSandbox();
  });

  it('writes hooks, subagents and files where Claude Code reads them, after the agent own hook', async () => {
    const order: string[] = [];
    await onSession([guard, reviewer], claudeCode, async () => {
      order.push('own');
      await writeFile(join(sandbox.directory, 'checked-out'), '');
    });
    order.push('plugins');
    expect(order).toEqual(['own', 'plugins']);

    const root = join(sandbox.directory, '.ai-sdk-harness/plugins/guard');
    expect(JSON.parse(await read('.claude/settings.local.json'))).toEqual({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: `"${root}/guard.sh"`, timeout: 5 }],
          },
        ],
        Stop: [{ hooks: [{ type: 'prompt', prompt: 'Is the work done?' }] }],
      },
    });
    expect(await read('.claude/agents/critic.md')).toBe(
      '---\nname: "critic"\ndescription: "Criticises."\ntools: "Read"\nmodel: "haiku"\n---\n\nFind the flaws.\n',
    );
    expect(await read('.claude/rules/reviewer/tone.md')).toBe('Be brief.\n');
    expect(await read('.claude/rules/reviewer/tests.md')).toBe(
      '---\npaths: ["src/**/*.ts"]\n---\n\nWrite a test for each change.\n',
    );
    expect(await read('.ai-sdk-harness/plugins/guard/guard.sh')).toBe('#!/bin/sh\nexit 0\n');
    expect((await stat(join(root, 'guard.sh'))).mode & 0o111).not.toBe(0);
    expect(await read('.ai-sdk-harness/.gitignore')).toBe('*\n');
  });

  it('keeps the settings and hooks the file had, and takes back what a turned-off plugin wrote', async () => {
    await mkdir(join(sandbox.directory, '.claude'), { recursive: true });
    const own = {
      permissions: { allow: ['Read'] },
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'mine' }] }] },
    };
    await writeFile(join(sandbox.directory, '.claude/settings.local.json'), JSON.stringify(own));

    await onSession([guard, reviewer]);
    const settings = JSON.parse(await read('.claude/settings.local.json')) as {
      hooks: Record<string, unknown[]>;
    };
    expect(settings.hooks.Stop).toHaveLength(2);

    // Resumed with the reviewer only: the guard's hooks and files go, the critic stays.
    await onSession([reviewer]);
    expect(JSON.parse(await read('.claude/settings.local.json'))).toEqual(own);
    expect(await exists(join(sandbox.directory, '.ai-sdk-harness/plugins/guard/guard.sh'))).toBe(
      false,
    );
    expect(await exists(join(sandbox.directory, '.claude/agents/critic.md'))).toBe(true);

    // Resumed with no plugin: the critic goes as well; the file keeps the developer's settings.
    await onSession([]);
    expect(await exists(join(sandbox.directory, '.claude/agents/critic.md'))).toBe(false);
    expect(JSON.parse(await read('.claude/settings.local.json'))).toEqual(own);
  });

  it('removes the settings file it alone created once no plugin has hooks', async () => {
    await onSession([guard]);
    await onSession([guard]);
    const { hooks } = JSON.parse(await read('.claude/settings.local.json')) as {
      hooks: Record<string, unknown[]>;
    };
    expect(Object.keys(hooks)).toEqual(['PreToolUse', 'Stop']);
    expect(hooks.Stop).toHaveLength(1);
    await onSession([]);
    expect(await exists(join(sandbox.directory, '.claude/settings.local.json'))).toBe(false);
  });

  it('writes no settings file for plugins without hooks, and only the files for Codex', async () => {
    await onSession([reviewer]);
    expect(await exists(join(sandbox.directory, '.claude/settings.local.json'))).toBe(false);

    sandbox = await createHostSandbox();
    await onSession([guard, reviewer], codex);
    expect(await exists(join(sandbox.directory, '.claude'))).toBe(false);
    expect(await read('.ai-sdk-harness/plugins/guard/guard.sh')).toBe('#!/bin/sh\nexit 0\n');
  });

  it('keeps what it wrote out of Git', async () => {
    execFileSync('git', ['init', '--quiet', sandbox.directory]);
    await onSession([guard, reviewer]);
    const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd: sandbox.directory,
      encoding: 'utf8',
    });
    expect(status).toBe('');
    await onSession([guard, reviewer]);
    const exclude = await read('.git/info/exclude');
    expect(exclude.match(/\/\.claude\/agents\/critic\.md/g)).toHaveLength(1);
  });

  it('starts over from a manifest it cannot read', async () => {
    await mkdir(join(sandbox.directory, '.ai-sdk-harness'), { recursive: true });
    await writeFile(join(sandbox.directory, '.ai-sdk-harness/manifest.json'), '{ not json');
    await onSession([reviewer]);
    await writeFile(join(sandbox.directory, '.ai-sdk-harness/manifest.json'), '{"version":2}');
    await onSession([reviewer]);
    expect(JSON.parse(await read('.ai-sdk-harness/manifest.json'))).toEqual({
      version: 1,
      files: [
        '.claude/agents/critic.md',
        '.claude/rules/reviewer/tone.md',
        '.claude/rules/reviewer/tests.md',
      ],
      createdSettings: false,
      hookGroups: [],
    });
  });

  it('refuses a settings file that is not JSON, and reports a failing command', async () => {
    await mkdir(join(sandbox.directory, '.claude'), { recursive: true });
    await writeFile(join(sandbox.directory, '.claude/settings.local.json'), 'nope');
    await expect(onSession([guard])).rejects.toThrow(
      ".claude/settings.local.json in the session's working directory is not valid JSON.",
    );

    sandbox = await createHostSandbox();
    await writeFile(join(sandbox.directory, '.ai-sdk-harness'), 'a file, not a directory');
    await expect(onSession([guard])).rejects.toThrow(
      'A plugin command failed in the sandbox (exit 1)',
    );
  });
});
