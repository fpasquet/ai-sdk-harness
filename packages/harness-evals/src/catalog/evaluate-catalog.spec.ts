import type { Plugin } from 'ai-sdk-harness-plugins';

import { createCatalog } from 'ai-sdk-harness-plugins';
import { describe, expect, it } from 'vitest';

import { call, FakeAgent, fakeSandboxes, sandbox, say } from '../../test/fake-agent.js';
import { evaluateCatalog, formatCatalogReport, InvalidEvalError } from '../index.js';

const tour = {
  name: 'tour',
  description: 'Tours the code.',
  commands: [{ name: 'tour', description: 'Tour', prompt: 'Give a tour of $ARGUMENTS.' }],
  evals: [{ name: 'tours', prompt: '/tour src', expect: { includes: 'Tour' } }],
};
const npm = {
  kind: 'tool',
  name: 'npm-latest',
  type: 'http',
  description: 'The latest version of a package.',
  url: 'https://registry.npmjs.org/zod/latest',
  evals: [
    { name: 'reads the registry', prompt: 'Latest zod?', expect: { calledTools: ['npm-latest'] } },
  ],
};
const guard = {
  kind: 'hook',
  name: 'guard',
  event: 'PreToolUse',
  command: 'exit 0',
  evals: [{ name: 'blocks', prompt: 'rm', harnesses: ['claude-code'] }],
};

/** One fake agent per set of plugins: the one with none is the baseline. */
function agents(): { agent: (plugins: Plugin[]) => FakeAgent; built: Map<string, FakeAgent> } {
  const built = new Map<string, FakeAgent>();
  return {
    built,
    agent: (plugins) => {
      const key = plugins.map(({ name }) => name).join(',') || 'baseline';
      const agent = new FakeAgent();
      // With the tool, the agent calls it; with the command, it gives the tour.
      agent.script = plugins.some(({ tools }) => tools?.['npm-latest'])
        ? [{ chunks: [...call('npm-latest', { name: 'zod' }), ...say('4.1.0')] }]
        : [{ chunks: say(plugins.length > 0 ? 'Tour of src' : 'I do not know /tour') }];
      built.set(key, agent);
      return agent;
    },
  };
}

describe('evaluateCatalog', () => {
  it('runs the cases of each entry with it and without it', async () => {
    const catalog = createCatalog({ plugins: [tour], items: [npm, guard] });
    const { agent, built } = agents();
    const ended: string[] = [];

    const report = await evaluateCatalog({
      catalog,
      agent,
      sandbox,
      harness: 'codex',
      onEntryEnd: ({ id }) => ended.push(id),
    });

    // As each entry ends; the report keeps the catalog's order.
    expect(ended.sort()).toEqual(['hook:guard', 'plugin:tour', 'tool:npm-latest']);
    expect(report.entries.map(({ id }) => id)).toEqual([
      'plugin:tour',
      'tool:npm-latest',
      'hook:guard',
    ]);
    expect(report.passed).toBe(true);
    const [tourReport, npmReport, guardReport] = report.entries;
    expect(tourReport?.comparison?.improved).toEqual(['tours']);
    expect(npmReport?.comparison?.improved).toEqual(['reads the registry']);
    expect(guardReport?.report.cases[0]?.skipped).toBe('made for claude-code, not codex');
    // The command is expanded with the entry's plugins only: the baseline gets it as it is.
    expect(built.get('tour')?.prompts).toEqual(['Give a tour of src.']);
    expect(formatCatalogReport(report)).toContain(
      '3/3 entries passed · 2/3 better than without them',
    );
  });

  it('evaluates only the entries named, without a baseline when told', async () => {
    const catalog = createCatalog({ plugins: [tour], items: [npm] });
    const { agent, built } = agents();

    const report = await evaluateCatalog({
      catalog,
      agent,
      sandbox,
      only: ['tool:npm-latest'],
      baseline: false,
    });

    expect(report.entries.map(({ id, baseline }) => [id, baseline])).toEqual([
      ['tool:npm-latest', undefined],
    ]);
    expect([...built.keys()]).toEqual(['tool-npm-latest']);
  });

  it('refuses an entry it cannot evaluate before running any', async () => {
    const broken = { ...npm, evals: [{ name: 'x', prompt: 'y', expect: { calls: ['a'] } }] };
    const { agent, built } = agents();

    const unknown = await evaluateCatalog({
      catalog: createCatalog({ plugins: [tour] }),
      agent,
      sandbox,
      only: ['tool:nothing'],
    }).catch((error: unknown) => error);
    const without = await evaluateCatalog({
      catalog: createCatalog({ plugins: [tour] }),
      agent,
      sandbox,
      only: ['tour/command:tour'],
    }).catch((error: unknown) => error);
    const invalid = await evaluateCatalog({
      catalog: createCatalog({ plugins: [tour], items: [broken] }),
      agent,
      sandbox,
    }).catch((error: unknown) => error);

    expect((unknown as Error).message).toBe('The catalog has no tool:nothing.');
    expect((without as Error).message).toBe('tour/command:tour has no eval cases.');
    expect(InvalidEvalError.isInstance(invalid)).toBe(true);
    expect((invalid as Error).message).toMatch(
      /^tool:npm-latest: Case "x": `expect\.calls` is no expectation/,
    );
    expect(built.size).toBe(0);
  });

  it('runs the entries at once, within what the sandboxes hold', async () => {
    const catalog = createCatalog({ plugins: [tour], items: [npm] });
    const sandboxes = fakeSandboxes(3);
    const agent = (): FakeAgent => {
      const fake = new FakeAgent();
      fake.script = [{ delayMs: 20, chunks: say('Tour of src') }];
      return fake;
    };

    await evaluateCatalog({ catalog, agent, sandbox: sandboxes, concurrency: 2 });

    // Two entries, each with it and without it: four trials, two at a time.
    expect(sandboxes.events.filter((event) => event.startsWith('acquire'))).toHaveLength(4);
    expect(sandboxes.peak).toBe(2);
  });
});
