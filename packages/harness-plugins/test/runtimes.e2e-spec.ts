import type { HarnessAgentAdapter } from '@ai-sdk/harness/agent';
import type { SbxNetworkSandboxSession } from 'ai-sdk-sandbox-sbx';

import { createClaudeCode } from '@ai-sdk/harness-claude-code';
import { createCodex } from '@ai-sdk/harness-codex';
import { createHarnessSandboxTemplate, HarnessAgent } from '@ai-sdk/harness/agent';
import { createSbxNetworkSandboxSession } from 'ai-sdk-sandbox-sbx';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Plugin, ResolvedPlugins } from '../src/index.js';

import { expandCommand, pluginHarnessSettings, resolvePlugins, withPlugins } from '../src/index.js';

/**
 * Real Claude Code and Codex turns, with plugins, in a Docker Sandbox: needs `sbx` signed in, and
 * a credential for each runtime — `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` and
 * `OPENAI_API_KEY`, or the login of the `claude` and `codex` CLIs on this host. The sandbox is
 * removed at the end; the template image, shared with the example, is kept.
 *
 * The plugins come from stored manifests, as a back office would keep them: a sandbox-command
 * tool, a command, a hook, rules — for every file, and for some —, an MCP server run by the
 * runtime in the sandbox, and one run on this host, whose tools the runtime calls over the bridge.
 */
const SERVER = readFileSync(join(import.meta.dirname, 'fixtures/mcp-server.mjs'), 'utf8');
const RUNTIMES = {
  'claude-code': { create: createClaudeCode, model: 'claude-haiku-4-5' },
  codex: { create: createCodex, model: 'gpt-5.5' },
} as const;

const hostWord = `host-${randomBytes(3).toString('hex')}`;
const sandboxWord = `sandbox-${randomBytes(3).toString('hex')}`;
const ruleWord = `rule-${randomBytes(3).toString('hex')}`;
const notesWord = `notes-${randomBytes(3).toString('hex')}`;

/** Plugins as they would come out of a database. */
const manifests = [
  {
    name: 'vault',
    description: 'Two MCP servers with a secret word each.',
    files: [{ path: 'server.mjs', content: SERVER }],
    mcpServers: {
      boxvault: {
        type: 'stdio',
        runIn: 'sandbox',
        command: 'node',
        args: ['${PLUGIN_ROOT}/server.mjs'],
        env: { SECRET_WORD: sandboxWord },
      },
      hostvault: {
        type: 'stdio',
        command: process.execPath,
        args: [join(import.meta.dirname, 'fixtures/mcp-server.mjs')],
        env: { SECRET_WORD: hostWord },
      },
    },
    commands: [
      {
        name: 'secrets',
        description: 'Gather the secret words',
        prompt:
          'Call the get_secret_word tool of the boxvault MCP server, then the ' +
          'hostvault_get_secret_word tool, then the kernel tool. Answer with one line: ' +
          '`SANDBOX=<word> HOST=<word> KERNEL=<the tool output>`. $ARGUMENTS',
      },
    ],
    tools: {
      kernel: {
        type: 'sandbox-command',
        description: 'Gives the name of the kernel of the sandbox.',
        command: 'uname -s',
      },
    },
  },
  {
    name: 'house',
    description: 'The rules of the house.',
    rules: [
      {
        name: 'codeword',
        content: `End every answer with a line of its own: \`RULE=${ruleWord}\`.`,
      },
      {
        name: 'notes',
        paths: ['notes/**'],
        content: `When you read a file in notes/, end your answer with a line of its own: \`NOTES=${notesWord}\`.`,
      },
    ],
  },
  {
    name: 'guard',
    description: 'Blocks a marker in shell commands.',
    hooks: [
      {
        event: 'PreToolUse',
        matcher: 'Bash',
        command:
          "grep -q FORBIDDEN-MARKER && { echo 'Blocked by the guard plugin.' >&2; exit 2; } || exit 0",
      },
    ],
  },
];

describe('plugins on real runtimes', () => {
  let sandbox: SbxNetworkSandboxSession;
  let resolved: ResolvedPlugins;

  beforeAll(async () => {
    // No connectMcpServer: @ai-sdk/mcp connects the servers your server runs.
    resolved = await resolvePlugins(manifests);
    sandbox = await createSbxNetworkSandboxSession({
      sandboxId: `ai-sdk-plugins-e2e-${randomBytes(3).toString('hex')}`,
      ports: [4000],
      setup: ['npm install --global --silent pnpm@10'],
      template: await createHarnessSandboxTemplate({
        harnesses: [createClaudeCode(), createCodex()],
      }),
    });
  });

  afterAll(async () => {
    await resolved?.close();
    await sandbox?.destroy();
  });

  /** A turn of `runtime` with the plugins, and what it did. */
  async function turn(runtime: keyof typeof RUNTIMES, plugins: Plugin[], message: string) {
    const { create, model } = RUNTIMES[runtime];
    const harness: HarnessAgentAdapter = create({ ...pluginHarnessSettings(runtime, plugins) });
    const agent = new HarnessAgent(
      withPlugins({ harness, model }, plugins, { onUnsupported: () => undefined }),
    );
    const session = await agent.createSession({ sandboxSession: sandbox });
    try {
      const prompt = expandCommand(message, plugins)?.prompt ?? message;
      const result = await agent.generate({ session, prompt });
      const outputs = result.steps.flatMap((step) =>
        step.content.flatMap((part) =>
          part.type === 'tool-result' || part.type === 'tool-error'
            ? [
                {
                  tool: part.toolName,
                  output: JSON.stringify(part.type === 'tool-error' ? part.error : part.output),
                },
              ]
            : [],
        ),
      );
      return { text: result.text, outputs };
    } finally {
      await session.destroy();
    }
  }

  it.each(['claude-code', 'codex'] as const)(
    '%s calls the sandbox MCP server, the host one and a sandbox-command tool',
    async (runtime) => {
      const { text, outputs } = await turn(runtime, resolved.plugins, '/secrets');

      expect(text).toContain(sandboxWord);
      expect(text).toContain(hostWord);
      expect(text).toContain('Linux');
      expect(outputs.map(({ tool }) => tool)).toEqual(
        expect.arrayContaining(['hostvault_get_secret_word', 'kernel']),
      );
    },
  );

  it.each(['claude-code', 'codex'] as const)(
    '%s follows a rule for every file, and one for some files once it works on them',
    async (runtime) => {
      const before = await turn(runtime, resolved.plugins, 'What is 2 + 2? Answer in a word.');
      expect(before.text).toContain(`RULE=${ruleWord}`);
      expect(before.text).not.toContain(notesWord);

      const after = await turn(
        runtime,
        resolved.plugins,
        // Claude Code loads a rule with paths once the agent reads a matching file.
        'Run `mkdir -p notes && echo "buy milk" > notes/todo.md` in the shell, then read notes/todo.md with your file reading tool and give its first line.',
      );
      expect(after.text).toContain(`NOTES=${notesWord}`);
    },
  );

  it('claude-code runs the hook of a plugin, which blocks a command', async () => {
    const { outputs } = await turn(
      'claude-code',
      resolved.plugins,
      'Run exactly this command with the Bash tool, once: echo FORBIDDEN-MARKER. Then report its output or error verbatim.',
    );

    expect(outputs.some(({ output }) => output.includes('Blocked by the guard plugin.'))).toBe(
      true,
    );
  });
});
