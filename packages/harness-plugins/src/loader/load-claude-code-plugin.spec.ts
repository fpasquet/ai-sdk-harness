import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { PluginLoadError } from '../errors/plugin-load-error.js';
import { loadClaudeCodePlugin } from './load-claude-code-plugin.js';

const FIXTURE = join(import.meta.dirname, '../../test/fixtures/claude-plugin');

/** A plugin directory made of `files`, by path. */
async function pluginDir(files: Record<string, string | Uint8Array>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'claude-plugin-'));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

describe('loadClaudeCodePlugin', () => {
  it('reads every part of a Claude Code plugin', async () => {
    const plugin = await loadClaudeCodePlugin(FIXTURE);
    expect(plugin).toEqual({
      name: 'release-kit',
      description: 'Prepare releases: notes, checks and a guard on tags.',
      version: '1.2.0',
      commands: [
        {
          name: 'git:sync',
          description: 'Fetch and rebase the current branch on its upstream.',
          prompt: 'Fetch and rebase the current branch on its upstream.',
        },
        {
          name: 'release',
          description: 'Prepare the release of a version',
          argumentHint: '<version>',
          prompt: 'Prepare release $1: read the changes since the last tag and draft the notes.',
        },
      ],
      subagents: [
        {
          name: 'changelog-writer',
          description: 'Writes changelog entries: one line per change',
          instructions: 'You write changelog entries.',
          tools: ['Read', 'Grep', 'Glob'],
          model: 'haiku',
        },
      ],
      skills: [
        {
          name: 'release-notes',
          description: 'How to write release notes for this project.',
          content: '# Release notes\n\nGroup the changes by kind. See template.md.',
          files: [{ path: 'template.md', content: '## Features\n' }],
        },
      ],
      hooks: [
        {
          event: 'PreToolUse',
          matcher: 'Bash',
          timeout: 10,
          command: '${CLAUDE_PLUGIN_ROOT}/scripts/guard-tags.sh',
        },
        { event: 'Stop', prompt: 'Did the agent update the changelog?' },
      ],
      mcpServers: {
        changelog: {
          type: 'stdio',
          runIn: 'sandbox',
          command: 'npx',
          args: ['-y', 'changelog-mcp'],
          env: { LEVEL: 'info' },
        },
        docs: {
          type: 'http',
          url: 'https://docs.example.com/mcp',
          headers: { 'X-Team': 'release' },
        },
      },
      files: [
        {
          path: 'scripts/guard-tags.sh',
          content: expect.stringContaining('git push --tags') as string,
          executable: true,
        },
      ],
    });
  });

  it('reads the paths and objects plugin.json gives instead of the default places', async () => {
    const root = await pluginDir({
      '.claude-plugin/plugin.json': JSON.stringify({
        name: 'custom',
        commands: ['./extra/one.md', './more'],
        agents: './people',
        hooks: { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'true' }] }] } },
        mcpServers: './config/mcp.json',
      }),
      'commands/base.md': 'Base.',
      'extra/one.md': 'One.',
      'more/two.md': 'Two.',
      'more/notes.txt': 'not a command',
      'people/helper.md': 'Help.',
      'config/mcp.json': JSON.stringify({ bare: { url: 'https://bare.example.com' } }),
      'assets/logo.png': new Uint8Array([137, 80, 78, 71, 0, 1]),
      'node_modules/dep/index.js': 'ignored',
    });
    const plugin = await loadClaudeCodePlugin(root);
    expect(plugin.description).toBe('');
    expect(plugin.commands?.map(({ name }) => name)).toEqual(['base', 'one', 'two']);
    expect(plugin.subagents).toEqual([{ name: 'helper', description: '', instructions: 'Help.' }]);
    expect(plugin.hooks).toEqual([{ event: 'Stop', command: 'true' }]);
    expect(plugin.mcpServers).toEqual({ bare: { type: 'http', url: 'https://bare.example.com' } });
    expect(plugin.files?.map(({ path }) => path)).toEqual([
      'config/mcp.json',
      'extra/one.md',
      'more/notes.txt',
      'more/two.md',
      'people/helper.md',
    ]);
  });

  it('leaves out what a minimal plugin does not have', async () => {
    const root = await pluginDir({
      '.claude-plugin/plugin.json': '{"name":"minimal","description":"Min."}',
    });
    expect(await loadClaudeCodePlugin(root)).toEqual({ name: 'minimal', description: 'Min.' });
  });

  it.each([
    [{}, 'it has no .claude-plugin/plugin.json object.'],
    [{ '.claude-plugin/plugin.json': '[]' }, 'it has no .claude-plugin/plugin.json object.'],
    [{ '.claude-plugin/plugin.json': '{' }, 'not valid JSON'],
    [{ '.claude-plugin/plugin.json': '{"name":"Bad Name"}' }, 'its name is not a kebab-case slug.'],
    [
      { '.claude-plugin/plugin.json': '{"name":"a"}', '.mcp.json': '{"x":{}}' },
      'the MCP server "x" has neither a url nor a command.',
    ],
  ])('refuses a directory that is not a valid plugin (%#)', async (files, message) => {
    const root = await pluginDir(files);
    await expect(loadClaudeCodePlugin(root)).rejects.toThrow(PluginLoadError);
    await expect(loadClaudeCodePlugin(root)).rejects.toThrow(message);
  });
});
