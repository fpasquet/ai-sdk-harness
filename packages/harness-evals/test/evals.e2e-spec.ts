import type { ResolvedPlugins } from 'ai-sdk-harness-plugins';
import type { SbxNetworkSandboxSession } from 'ai-sdk-sandbox-sbx';

import { createClaudeCode } from '@ai-sdk/harness-claude-code';
import { createHarnessSandboxTemplate, HarnessAgent } from '@ai-sdk/harness/agent';
import { resolvePlugins, withPlugins } from 'ai-sdk-harness-plugins';
import { createSbxNetworkSandboxSession } from 'ai-sdk-sandbox-sbx';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { EvalCase } from '../src/index.js';

import { compareReports, evaluate, formatComparison, formatReport } from '../src/index.js';

/**
 * Real Claude Code turns in a Docker Sandbox, evaluated with and without a plugin: needs `sbx`
 * signed in, and `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY` or the login of the `claude` CLI on
 * this host. The sandbox is removed at the end; the template image, shared with the example, is
 * kept.
 */
const MODEL = 'claude-haiku-4-5';
const ruleWord = `rule-${randomBytes(3).toString('hex')}`;

const manifests = [
  {
    name: 'house',
    description: 'A tool that names the kernel, a rule, and a command.',
    tools: {
      kernel: {
        type: 'sandbox-command',
        description: 'Gives the name of the kernel of the sandbox.',
        command: 'uname -s',
      },
    },
    rules: [
      {
        name: 'codeword',
        content: `End every answer with a line of its own: \`RULE=${ruleWord}\`.`,
      },
    ],
    commands: [
      {
        name: 'kernel',
        description: 'Name the kernel',
        prompt: 'Call the kernel tool once, then answer with its output and nothing else.',
      },
    ],
  },
];

const cases: EvalCase[] = [
  {
    name: 'names the kernel with its tool',
    prompt: '/kernel',
    expect: { calledTools: ['kernel'], includes: 'Linux', maxToolCalls: 2, noToolErrors: true },
  },
  {
    name: 'follows the house rule',
    prompt: 'What is 2 + 2? Answer in a word.',
    expect: { includes: `RULE=${ruleWord}`, notCalledTools: ['bash'] },
  },
  {
    name: 'remembers across turns',
    prompt: ['My favourite word is marigold. Just say OK.', 'What is my favourite word?'],
    expect: { includes: /marigold/i },
  },
];

describe('evals on a real runtime', () => {
  let sandbox: SbxNetworkSandboxSession;
  let resolved: ResolvedPlugins;

  beforeAll(async () => {
    resolved = await resolvePlugins(manifests);
    sandbox = await createSbxNetworkSandboxSession({
      sandboxId: `ai-sdk-evals-e2e-${randomBytes(3).toString('hex')}`,
      ports: [4000],
      setup: ['npm install --global --silent pnpm@10'],
      template: await createHarnessSandboxTemplate({ harnesses: [createClaudeCode()] }),
    });
  });

  afterAll(async () => {
    await resolved?.close();
    await sandbox?.destroy();
  });

  it('evaluates a plugin: the agent with it against the agent without it', async () => {
    const harness = createClaudeCode();
    const without = await evaluate({
      agent: new HarnessAgent({ harness, model: MODEL }),
      sandbox,
      cases,
    });
    const withPlugin = await evaluate({
      agent: new HarnessAgent(
        withPlugins({ harness, model: MODEL }, resolved.plugins, {
          onUnsupported: () => undefined,
        }),
      ),
      sandbox,
      plugins: resolved.plugins,
      cases,
    });
    const comparison = compareReports(without, withPlugin);
    process.stdout.write(`${formatReport(withPlugin)}\n\n${formatComparison(comparison)}\n`);

    expect(withPlugin.passed, formatReport(withPlugin)).toBe(true);
    expect(comparison.improved).toEqual(
      expect.arrayContaining(['names the kernel with its tool', 'follows the house rule']),
    );
    const [kernel] = withPlugin.cases[0]!.trials;
    expect(kernel!.toolCalls).toContainEqual(
      expect.objectContaining({ name: 'kernel', status: 'completed' }),
    );
    expect(kernel!.usage.totalTokens).toBeGreaterThan(0);
  });
});
