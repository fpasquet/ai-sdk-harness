import { createClaudeCode } from '@ai-sdk/harness-claude-code';
import { createCodex } from '@ai-sdk/harness-codex';
import { HarnessAgent } from '@ai-sdk/harness/agent';
import { tool } from '@ai-sdk/provider-utils';
import { execFile, execFileSync } from 'node:child_process';
import { access, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { HostSandbox } from '../../test/host-sandbox.js';
import type { Plugin } from '../definitions/plugin.js';
import type { PluginAgentSettings } from './with-plugins.js';

import { createHostSandbox } from '../../test/host-sandbox.js';
import { resolvePlugins } from '../config/resolve-plugins.js';
import { InvalidPluginError } from '../errors/invalid-plugin-error.js';
import { groupKey } from '../session/local-settings.js';
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

/** The command of a hook of the plugins in `$HOME`: the gate, with the hook's id. */
const GATE = /^sh "\$HOME\/\.ai-sdk-harness\/hook-gate\.sh" ([0-9a-f]{16})$/;
const hookIdOf = (group: unknown): string =>
  GATE.exec((group as { hooks: [{ command: string }] }).hooks[0].command)?.[1] ?? '';

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
    expect(settings.instructions).toMatch(/^Be helpful\.\n\n# Rules\n/);
    expect(Object.keys(settings.tools)).toEqual(['own', 'echo']);
    expect(settings.skills.map(({ name }) => name)).toEqual(['own-skill', 'review-style']);
    // What the head of a skill says besides is for the application, not the runtime.
    const licensed = withPlugins({ harness: claudeCode }, [
      {
        name: 'licensed',
        description: '',
        skills: [
          {
            name: 'style',
            description: 'd',
            content: 'c',
            license: 'MIT',
            version: '1.0',
            allowedTools: ['Read'],
            requires: ['tool:echo'],
          },
        ],
      },
    ]);
    expect((licensed as { skills?: unknown }).skills).toEqual([
      { name: 'style', description: 'd', content: 'c' },
    ]);
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
    // Codex takes the guard's command hook, not its prompt hook.
    expect(onUnsupported.mock.calls).toEqual([
      [{ plugin: 'guard', feature: 'hooks', harnessId: 'codex', hook: 'stop-2' }],
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
      'Plugin "guard": codex does not support its hook "stop-2"; it is left out.',
      'AiSdkHarnessPluginsWarning',
    );
    withPlugins({ harness: unknown }, [guard]);
    expect(emitWarning).toHaveBeenLastCalledWith(
      'Plugin "guard": opencode does not support hooks; they are left out.',
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
      local: {
        type: 'stdio',
        command: 'node',
        args: ['s.mjs'],
        env: { NODE_USE_ENV_PROXY: '1' },
      },
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

  it('gives the rules in the instructions, after the agent own, on every runtime', () => {
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
    // Claude Code too: the adapter has it read nothing of the session's `.claude/`.
    expect(
      withPlugins({ harness: claudeCode, instructions: 'Be careful.' }, [reviewer]).instructions,
    ).toBe(`Be careful.\n\n${rules}`);
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
  const homeSettings = async () =>
    JSON.parse(await readFile(join(sandbox.home, '.claude/settings.json'), 'utf8')) as {
      permissions?: unknown;
      hooks: Record<string, undefined | unknown[]>;
    };

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

    // Under $HOME: Claude Code reads the user's settings alone. The prompt hook is left out.
    const { hooks } = await homeSettings();
    const gate: unknown = expect.stringMatching(GATE);
    expect(hooks).toEqual({
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [{ type: 'command', command: gate, timeout: 5 }],
        },
      ],
    });
    // The session holds the command the gate runs, its own files at ${PLUGIN_ROOT}.
    const root = join(sandbox.directory, '.ai-sdk-harness/plugins/guard');
    expect(await read(`.ai-sdk-harness/hooks/${hookIdOf(hooks.PreToolUse?.[0])}`)).toBe(
      `"${root}/guard.sh"\n`,
    );
    expect(await exists(join(sandbox.directory, '.claude'))).toBe(false);
    expect(await readFile(join(sandbox.home, '.claude/agents/critic.md'), 'utf8')).toBe(
      '---\nname: "critic"\ndescription: "Criticises."\ntools: "Read"\nmodel: "haiku"\n---\n\nFind the flaws.\n',
    );
    expect(await read('.ai-sdk-harness/plugins/guard/guard.sh')).toBe('#!/bin/sh\nexit 0\n');
    expect((await stat(join(root, 'guard.sh'))).mode & 0o111).not.toBe(0);
    expect(await read('.ai-sdk-harness/.gitignore')).toBe('*\n');
  });

  it('runs a hook only in the sessions that have it, through the gate', async () => {
    const blocker: Plugin = {
      name: 'blocker',
      description: '',
      hooks: [{ event: 'PreToolUse', matcher: 'Bash', command: '"${PLUGIN_ROOT}/block.sh"' }],
      files: [
        {
          path: 'block.sh',
          content: '#!/bin/sh\ngrep -q MARKER && { echo blocked >&2; exit 2; }\nexit 0\n',
          executable: true,
        },
      ],
    };
    const sessionIn = async (directory: string, plugins: Plugin[]) => {
      const sessionWorkDir = join(sandbox.directory, directory);
      await mkdir(sessionWorkDir, { recursive: true });
      await withPlugins({ harness: claudeCode }, plugins).sandboxConfig.onSession?.({
        session: sandbox.session,
        sessionWorkDir,
      });
      return sessionWorkDir;
    };
    /** Runs the hook as Claude Code would: its command, in the session, the event on stdin. */
    const runHook = async (sessionWorkDir: string, event: string) => {
      const { hooks } = await homeSettings();
      const command = (hooks.PreToolUse?.[0] as { hooks: [{ command: string }] }).hooks[0].command;
      return new Promise<{ code: number; stderr: string }>((resolve) => {
        const child = execFile(
          'sh',
          ['-c', command],
          {
            cwd: sessionWorkDir,
            env: { ...process.env, HOME: sandbox.home, CLAUDE_PROJECT_DIR: sessionWorkDir },
          },
          (error, _stdout, stderr) =>
            resolve({ code: typeof error?.code === 'number' ? error.code : 0, stderr }),
        );
        // The gate of a session without the hook exits without reading the event: no EPIPE.
        child.stdin?.on('error', () => undefined);
        child.stdin?.end(event);
      });
    };

    const one = await sessionIn('one', [blocker]);
    // A session without the plugin, started later: the hook stays, for the first one.
    const two = await sessionIn('two', []);
    expect(await runHook(one, '{"command":"echo MARKER"}')).toEqual({
      code: 2,
      stderr: 'blocked\n',
    });
    expect(await runHook(one, '{"command":"ls"}')).toEqual({ code: 0, stderr: '' });
    expect(await runHook(two, '{"command":"echo MARKER"}')).toEqual({ code: 0, stderr: '' });

    // Another session with the plugin adds nothing: the group is there already.
    await sessionIn('three', [blocker]);
    expect((await homeSettings()).hooks.PreToolUse).toHaveLength(1);
  });

  it('keeps the settings and hooks $HOME had', async () => {
    const own = {
      permissions: { allow: ['Read'] },
      hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'mine' }] }] },
    };
    await mkdir(join(sandbox.home, '.claude'), { recursive: true });
    await writeFile(join(sandbox.home, '.claude/settings.json'), JSON.stringify(own));
    await onSession([guard]);
    const settings = await homeSettings();
    expect(settings.permissions).toEqual(own.permissions);
    expect(settings.hooks.PreToolUse).toEqual([
      ...own.hooks.PreToolUse,
      expect.objectContaining({ matcher: 'Bash' }),
    ]);
  });

  it('takes back the hooks an earlier version wrote in the session', async () => {
    const old = { matcher: 'Bash', hooks: [{ type: 'command', command: 'old' }] };
    const own = { hooks: [{ type: 'command', command: 'mine' }] };
    const earlier = async (settings: object, createdSettings: boolean) => {
      await mkdir(join(sandbox.directory, '.claude'), { recursive: true });
      await mkdir(join(sandbox.directory, '.ai-sdk-harness'), { recursive: true });
      await writeFile(
        join(sandbox.directory, '.claude/settings.local.json'),
        JSON.stringify(settings),
      );
      await writeFile(
        join(sandbox.directory, '.ai-sdk-harness/manifest.json'),
        JSON.stringify({
          version: 1,
          files: [],
          hookGroups: [groupKey('PreToolUse', old)],
          createdSettings,
        }),
      );
    };

    await earlier({ permissions: { allow: ['Read'] }, hooks: { PreToolUse: [own, old] } }, false);
    await onSession([guard]);
    expect(JSON.parse(await read('.claude/settings.local.json'))).toEqual({
      permissions: { allow: ['Read'] },
      hooks: { PreToolUse: [own] },
    });

    // A file that held the plugins' hooks alone goes.
    sandbox = await createHostSandbox();
    await earlier({ hooks: { PreToolUse: [old] } }, true);
    await onSession([]);
    expect(await exists(join(sandbox.directory, '.claude/settings.local.json'))).toBe(false);
  });

  it('writes no hooks for plugins without any, nor for Codex, which takes them from the adapter', async () => {
    await onSession([reviewer]);
    expect(await exists(join(sandbox.home, '.claude/settings.json'))).toBe(false);

    sandbox = await createHostSandbox();
    await onSession([guard, reviewer], codex);
    expect(await exists(join(sandbox.directory, '.claude'))).toBe(false);
    expect(await exists(join(sandbox.home, '.claude'))).toBe(false);
    expect(await read('.ai-sdk-harness/plugins/guard/guard.sh')).toBe('#!/bin/sh\nexit 0\n');
  });

  it('writes the subagents where Codex reads them, as its agent files', async () => {
    const planner: Plugin = {
      name: 'planner',
      description: '',
      subagents: [
        {
          name: 'planner',
          description: 'Plans "big" changes.',
          instructions: 'Write the plan.\nThen stop.',
          model: 'gpt-5.5',
        },
      ],
    };
    await onSession([reviewer, planner], codex);
    // No list of tools, and no Claude Code model alias: Codex has neither.
    expect(await read('.codex/agents/critic.toml')).toBe(
      'name = "critic"\ndescription = "Criticises."\ndeveloper_instructions = "Find the flaws."\n',
    );
    expect(await read('.codex/agents/planner.toml')).toBe(
      'name = "planner"\ndescription = "Plans \\"big\\" changes."\n' +
        'developer_instructions = "Write the plan.\\nThen stop."\nmodel = "gpt-5.5"\n',
    );

    // Resumed without the planner: its file goes, the critic's stays.
    await onSession([reviewer], codex);
    expect(await exists(join(sandbox.directory, '.codex/agents/planner.toml'))).toBe(false);
    expect(await exists(join(sandbox.directory, '.codex/agents/critic.toml'))).toBe(true);
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
    expect(exclude.match(/\/\.ai-sdk-harness\/plugins\/guard\/guard\.sh/g)).toHaveLength(1);
  });

  it('starts over from a manifest it cannot read', async () => {
    await mkdir(join(sandbox.directory, '.ai-sdk-harness'), { recursive: true });
    await writeFile(join(sandbox.directory, '.ai-sdk-harness/manifest.json'), '{ not json');
    await onSession([reviewer]);
    await writeFile(join(sandbox.directory, '.ai-sdk-harness/manifest.json'), '{"version":2}');
    await onSession([reviewer]);
    expect(JSON.parse(await read('.ai-sdk-harness/manifest.json'))).toEqual({
      version: 1,
      files: [],
      createdSettings: false,
      hookGroups: [],
    });
  });

  it('shares the Claude Code subagents between the sessions of a sandbox, the last one deciding', async () => {
    const homeAgent = (name: string) => join(sandbox.home, '.claude/agents', name);
    const sessionIn = async (
      directory: string,
      plugins: Plugin[],
      harness: PluginAgentSettings['harness'] = claudeCode,
    ) => {
      const sessionWorkDir = join(sandbox.directory, directory);
      await mkdir(sessionWorkDir, { recursive: true });
      await withPlugins({ harness }, plugins, {
        onUnsupported: () => undefined,
      }).sandboxConfig.onSession?.({ session: sandbox.session, sessionWorkDir });
    };
    const planner: Plugin = {
      name: 'planner',
      description: '',
      subagents: [{ name: 'planner', description: 'Plans.', instructions: 'Plan.' }],
    };

    await sessionIn('one', [reviewer, planner]);
    expect(await exists(homeAgent('critic.md'))).toBe(true);
    expect(await exists(homeAgent('planner.md'))).toBe(true);

    // Another session, without the planner: its subagent goes for every session of the sandbox.
    await sessionIn('two', [reviewer]);
    expect(await exists(homeAgent('critic.md'))).toBe(true);
    expect(await exists(homeAgent('planner.md'))).toBe(false);

    // A Codex session reads nothing there, and leaves the Claude Code subagents alone.
    await sessionIn('three', [planner], codex);
    expect(await exists(homeAgent('critic.md'))).toBe(true);
    expect(
      JSON.parse(await readFile(join(sandbox.home, '.ai-sdk-harness/home-manifest.json'), 'utf8')),
    ).toEqual({
      version: 1,
      files: ['.claude/agents/critic.md'],
    });

    // A Claude Code session without subagents takes back the last one.
    await sessionIn('four', []);
    expect(await readdir(join(sandbox.home, '.claude/agents'))).toEqual([]);
  });

  it('takes back the subagents written in the session by an earlier version', async () => {
    await mkdir(join(sandbox.directory, '.claude/agents'), { recursive: true });
    await writeFile(join(sandbox.directory, '.claude/agents/critic.md'), 'old');
    await mkdir(join(sandbox.directory, '.ai-sdk-harness'), { recursive: true });
    await writeFile(
      join(sandbox.directory, '.ai-sdk-harness/manifest.json'),
      JSON.stringify({ version: 1, files: ['.claude/agents/critic.md'] }),
    );
    await onSession([reviewer]);
    expect(await exists(join(sandbox.directory, '.claude/agents/critic.md'))).toBe(false);
    expect(await exists(join(sandbox.home, '.claude/agents/critic.md'))).toBe(true);
  });

  it('never overwrites a subagent of $HOME it did not write', async () => {
    await mkdir(join(sandbox.home, '.claude/agents'), { recursive: true });
    await writeFile(join(sandbox.home, '.claude/agents/critic.md'), 'mine');
    await expect(onSession([reviewer])).rejects.toThrow(
      '$HOME/.claude/agents/critic.md is already in the sandbox, and the plugins did not write it',
    );
    expect(await readFile(join(sandbox.home, '.claude/agents/critic.md'), 'utf8')).toBe('mine');
  });

  it('runs a script of the plugin from a sandbox-command, through ${PLUGIN_ROOT}', async () => {
    const counter: Plugin = {
      name: 'counter',
      description: '',
      tools: {
        count: {
          type: 'sandbox-command',
          description: 'Count the words',
          inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
          // Wherever the command goes first, the path stays absolute.
          command: 'cd / && "${PLUGIN_ROOT}/bin/count.sh"',
        },
      },
      files: [
        {
          path: 'bin/count.sh',
          content: '#!/bin/sh\nprintf "%s" "$INPUT_TEXT" | wc -w | tr -d " "\n',
          executable: true,
        },
      ],
    };
    // Resolved first, as an application does, or built by withPlugins on its own.
    for (const plugins of [(await resolvePlugins([counter])).plugins, [counter]]) {
      const settings = withPlugins({ harness: claudeCode }, plugins);
      // A session of its own, in a directory of the sandbox's default one: not where tools run.
      const sessionWorkDir = join(sandbox.directory, 'claude-code-1');
      await mkdir(sessionWorkDir, { recursive: true });
      await settings.sandboxConfig.onSession?.({ session: sandbox.session, sessionWorkDir });
      const count = settings.tools?.count as {
        execute: (input: unknown, options: object) => Promise<unknown>;
      };
      expect(
        await count.execute(
          { text: 'one two three' },
          { toolCallId: '1', messages: [], experimental_sandbox: sandbox.session },
        ),
      ).toEqual({ exitCode: 0, stdout: '3\n', stderr: '' });
    }
    const roots = await readdir(join(sandbox.home, '.ai-sdk-harness/plugin-files'));
    expect(roots).toEqual([expect.stringMatching(/^counter-[0-9a-f]{16}$/)]);

    // Another session of the sandbox finds them written: nothing is written twice.
    const before = sandbox.commands.length;
    await mkdir(join(sandbox.directory, 'claude-code-2'));
    await withPlugins({ harness: claudeCode }, [counter]).sandboxConfig.onSession?.({
      session: sandbox.session,
      sessionWorkDir: join(sandbox.directory, 'claude-code-2'),
    });
    expect(
      sandbox.commands.slice(before).filter((command) => command.includes('plugin-files')),
    ).toEqual([]);
  });

  it('refuses a settings file that is not JSON, and reports a failing command', async () => {
    await mkdir(join(sandbox.home, '.claude'), { recursive: true });
    await writeFile(join(sandbox.home, '.claude/settings.json'), 'nope');
    await expect(onSession([guard])).rejects.toThrow(
      '$HOME/.claude/settings.json in the sandbox is not valid JSON.',
    );

    sandbox = await createHostSandbox();
    await writeFile(join(sandbox.directory, '.ai-sdk-harness'), 'a file, not a directory');
    await expect(onSession([guard])).rejects.toThrow(
      'A plugin command failed in the sandbox (exit 1)',
    );
  });
});
