/**
 * Evaluates the marketplace: the eval cases each plugin and item carries (`evals`), on the agent
 * with it and on the agent without it. `pnpm evals [ids…] [--harness codex] [--model …]
 * [--trials 3] [--concurrency 4] [--no-baseline]`. The report is written to `.data/evals/`.
 */
import type { Plugin } from 'ai-sdk-harness-plugins';
import type { SessionSandboxes } from 'ai-sdk-harness-sessions';

import { createClaudeCode } from '@ai-sdk/harness-claude-code';
import { createCodex } from '@ai-sdk/harness-codex';
import { createHarnessSandboxTemplate, HarnessAgent } from '@ai-sdk/harness/agent';
import { evaluateCatalog, formatCatalogReport } from 'ai-sdk-harness-evals';
import { withPlugins } from 'ai-sdk-harness-plugins';
import { sandboxPerSession, sharedSandbox } from 'ai-sdk-harness-sessions';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import type { HarnessId } from '@/lib/harnesses';

const { values: options, positionals: ids } = parseArgs({
  allowPositionals: true,
  options: {
    harness: { type: 'string', default: 'claude-code' },
    model: { type: 'string' },
    trials: { type: 'string', default: '1' },
    concurrency: { type: 'string', default: '2' },
    'no-baseline': { type: 'boolean', default: false },
  },
});

// The credentials, as `next dev` reads them; and sandboxes of the evals' own, so that a run never
// stops the bridges of the example's conversations.
try {
  process.loadEnvFile('.env.local');
} catch {
  // No .env.local: the harnesses fall back to the logins of their CLIs.
}
process.env.EXAMPLE_SANDBOX_ID ??= 'ai-sdk-harness-evals';

const { defaultModel, isKnown } = await import('@/lib/harnesses');
const { marketplace } = await import('@/lib/plugins');
const {
  createConversationMicrosandbox,
  openSandbox,
  resumeConversationMicrosandbox,
  SANDBOX,
  SANDBOX_INSTRUCTIONS,
} = await import('@/lib/sandbox');

const harness = options.harness as HarnessId;
const model = options.model ?? defaultModel(harness);
if (!isKnown(harness, model)) {
  throw new Error(`Unknown agent: --harness ${harness} --model ${model}. See lib/harnesses.ts.`);
}
const concurrency = Number(options.concurrency);

const adapter = harness === 'codex' ? createCodex() : createClaudeCode();
const template = () => createHarnessSandboxTemplate({ harnesses: [adapter] });

/** The agent of the example, with `plugins`, asking nothing: the evals answer no approval. */
const agentWith = (plugins: Plugin[]): HarnessAgent =>
  new HarnessAgent(
    withPlugins(
      {
        id: `evals-${harness}`,
        harness: adapter,
        model,
        instructions: SANDBOX_INSTRUCTIONS[SANDBOX],
        permissionMode: 'allow-all' as const,
      },
      plugins,
      { onUnsupported: () => undefined },
    ),
  );

/**
 * The sandboxes of the trials, `--concurrency` at once, as the example's conversations get theirs:
 * views of one sandbox, a port each; with microsandbox, a microVM each, restored from the template
 * in a second and destroyed after its trial.
 */
const sandboxes: SessionSandboxes =
  SANDBOX === 'microsandbox'
    ? sandboxPerSession({
        create: (id, { abortSignal }) => createConversationMicrosandbox(id, template, abortSignal),
        resume: (id, { abortSignal }) => resumeConversationMicrosandbox(id, abortSignal),
        maxSessions: concurrency,
      })
    : sharedSandbox({
        open: () => openSandbox(template),
        ports: Array.from({ length: concurrency }, (_, i) => 4001 + i),
      });

process.stdout.write(`Evaluating the marketplace on ${harness} (${model}), in ${SANDBOX}.\n`);
const report = await evaluateCatalog({
  catalog: await marketplace(),
  agent: agentWith,
  sandbox: sandboxes,
  harness,
  trials: Number(options.trials),
  ...(ids.length > 0 && { only: ids }),
  baseline: !options['no-baseline'],
  // A line as each entry ends; the whole report once they all have.
  onEntryEnd: ({ id, report: entry }) =>
    process.stdout.write(`${entry.passed ? '✓' : '✗'} ${id}\n`),
});
await sandboxes.shutdown?.();
process.stdout.write(`\n${formatCatalogReport(report)}\n`);

const directory = join(process.cwd(), '.data/evals');
await mkdir(directory, { recursive: true });
const file = join(directory, `${new Date().toISOString().replace(/[:.]/g, '-')}-${harness}.json`);
await writeFile(file, JSON.stringify({ harness, model, sandbox: SANDBOX, report }, null, 2));
process.stdout.write(`Report: ${file}\n`);
process.exitCode = report.passed ? 0 : 1;
