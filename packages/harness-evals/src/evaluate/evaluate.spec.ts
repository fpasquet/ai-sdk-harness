import type { Plugin } from 'ai-sdk-harness-plugins';

import { describe, expect, it } from 'vitest';

import type { EvaluateSettings } from '../index.js';

import { ask, call, fail, FakeAgent, fakeSandboxes, sandbox, say } from '../../test/fake-agent.js';
import { judgeModel } from '../../test/judge-model.js';
import { evaluate, InvalidEvalError } from '../index.js';

describe('evaluate', () => {
  it('passes a case whose expectations the agent meets', async () => {
    const agent = new FakeAgent();
    agent.script = [
      {
        chunks: [...call('Bash', { command: 'uname -s' }, 'Linux'), ...say('The kernel is Linux.')],
      },
    ];

    const report = await evaluate({
      agent,
      sandbox,
      cases: [
        {
          name: 'kernel',
          prompt: 'Which kernel?',
          expect: { includes: 'Linux', calledTools: ['bash'], maxToolCalls: 1, noToolErrors: true },
        },
      ],
    });

    expect(report.passed).toBe(true);
    expect(report.score).toBe(1);
    const [run] = report.cases[0]!.trials;
    expect(run).toMatchObject({
      text: 'The kernel is Linux.',
      toolCalls: [
        {
          name: 'Bash',
          input: { command: 'uname -s' },
          output: 'Linux',
          status: 'completed',
          turn: 0,
        },
      ],
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    });
    expect(run!.checks.map(({ name }) => name)).toEqual([
      'includes(Linux)',
      'calledTools(bash)',
      'maxToolCalls(1)',
      'noToolErrors',
    ]);
    expect(agent.sessions).toEqual([expect.objectContaining({ destroyed: true })]);
  });

  it('says what each failed check observed', async () => {
    const agent = new FakeAgent();
    agent.script = [
      {
        chunks: [
          ...fail('kernel', {}, 'command not found'),
          ...call('Read', { file_path: '/etc/os-release' }),
          ...say('I could not tell.'),
        ],
      },
    ];

    const report = await evaluate({
      agent,
      sandbox,
      cases: [
        {
          name: 'kernel',
          prompt: 'Which kernel?',
          expect: {
            includes: [/linux/i],
            excludes: 'could not',
            calledTools: ['kernel', 'bash'],
            notCalledTools: ['read'],
            maxToolCalls: 1,
            noToolErrors: true,
          },
        },
      ],
    });

    expect(report.passed).toBe(false);
    const { checks, score } = report.cases[0]!.trials[0]!;
    expect(
      checks.filter(({ passed }) => !passed).map(({ name, message }) => [name, message]),
    ).toEqual([
      ['includes(/linux/i)', 'got I could not tell.'],
      ['excludes(could not)', 'got I could not tell.'],
      ['calledTools(kernel)', 'every call ended failed'],
      ['calledTools(bash)', 'called kernel, Read'],
      ['notCalledTools(read)', 'called 1 time(s)'],
      ['maxToolCalls(1)', 'made 2 calls: kernel, Read'],
      ['noToolErrors', 'kernel: command not found'],
    ]);
    expect(score).toBe(0);
  });

  it('runs the prompts of a case as the turns of one session', async () => {
    const agent = new FakeAgent();
    agent.script = [
      { chunks: say('Noted.') },
      { chunks: [...call('recall', {}), ...say('Marigold.')] },
    ];

    const report = await evaluate({
      agent,
      sandbox,
      cases: [
        {
          name: 'memory',
          prompt: ['My favourite word is marigold.', 'What is my favourite word?'],
          expect: { includes: 'Marigold' },
        },
      ],
    });

    const run = report.cases[0]!.trials[0]!;
    expect(agent.sessions).toHaveLength(1);
    expect(
      run.turns.map(({ text, toolCalls }) => [text, toolCalls.map(({ turn }) => turn)]),
    ).toEqual([
      ['Noted.', []],
      ['Marigold.', [1]],
    ]);
    expect(run.text).toBe('Marigold.');
    expect(run.messages.map(({ role }) => role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
    expect(run.usage.totalTokens).toBe(30);
  });

  it('approves the tool calls a turn pauses on, and continues the same message', async () => {
    const agent = new FakeAgent();
    const request = ask('Bash', { command: 'rm -rf build' });
    agent.script = [
      { chunks: request.chunks },
      {
        chunks: [
          {
            type: 'tool-output-available',
            toolCallId: request.toolCallId,
            output: '',
            dynamic: true,
          },
          ...say('Removed.'),
        ],
      },
    ];

    const report = await evaluate({
      agent,
      sandbox,
      cases: [{ name: 'clean', prompt: 'Clean the build.', expect: { calledTools: ['bash'] } }],
    });

    expect(report.passed).toBe(true);
    expect(agent.continuations).toEqual([
      [{ type: 'tool-approval-response', approvalId: request.approvalId, approved: true }],
    ]);
    const run = report.cases[0]!.trials[0]!;
    expect(run.messages).toHaveLength(2);
    expect(run.toolCalls).toEqual([expect.objectContaining({ name: 'Bash', status: 'completed' })]);
  });

  it('denies them when the case says so', async () => {
    const agent = new FakeAgent();
    const request = ask('Bash', { command: 'git push --force' });
    agent.script = [{ chunks: request.chunks }, { chunks: say('I was not allowed to push.') }];

    const report = await evaluate({
      agent,
      sandbox,
      approvals: 'approve',
      cases: [
        {
          name: 'push',
          prompt: 'Push.',
          approvals: 'deny',
          expect: { includes: 'not allowed' },
        },
      ],
    });

    expect(report.passed).toBe(true);
    expect(agent.continuations[0]).toEqual([
      expect.objectContaining({ approvalId: request.approvalId, approved: false }),
    ]);
    expect(report.cases[0]!.trials[0]!.toolCalls[0]!.status).toBe('denied');
  });

  it('finds the skills the agent loaded, on Claude Code and on Codex', async () => {
    const agent = new FakeAgent();
    agent.script = [
      {
        chunks: [
          ...call('Skill', { skill: 'code-tour' }),
          ...call('shell', { command: 'cat ~/.agents/skills/release-notes/SKILL.md' }),
          ...say('Done.'),
        ],
      },
    ];

    const report = await evaluate({
      agent,
      sandbox,
      cases: [
        {
          name: 'skills',
          prompt: 'Tour.',
          expect: { loadedSkills: ['code-tour', 'release-notes'] },
        },
      ],
    });

    expect(report.cases[0]!.trials[0]!.skills).toEqual(['code-tour', 'release-notes']);
    expect(report.passed).toBe(true);
  });

  it('expands the /commands of the plugins, as the application would', async () => {
    const agent = new FakeAgent();
    const plugins: Plugin[] = [
      {
        name: 'tour',
        description: 'Tours the code.',
        commands: [
          { name: 'tour', description: 'Tour the code', prompt: 'Give a tour of $ARGUMENTS.' },
        ],
      },
    ];

    await evaluate({
      agent,
      sandbox,
      plugins,
      cases: [{ name: 'tour', prompt: '/tour the parser' }],
    });

    expect(agent.prompts).toEqual(['Give a tour of the parser.']);
  });

  it('grades the judge expectations with the judge model, never the agent', async () => {
    const agent = new FakeAgent();
    agent.script = [
      { chunks: [...call('docs', { q: 'zod' }), ...say('Use z.discriminatedUnion.')] },
    ];
    const judge = judgeModel(
      { score: 0.9, reason: 'It shows the API.' },
      { score: 0.4, reason: 'No source.' },
    );

    const report = await evaluate({
      agent,
      sandbox,
      judge,
      cases: [
        {
          name: 'docs',
          prompt: 'Discriminated unions in zod?',
          expect: {
            judge: ['Names the API to use', { criteria: 'Cites a source', threshold: 0.3 }],
          },
        },
      ],
    });

    const { checks, score, passed } = report.cases[0]!.trials[0]!;
    expect(checks).toEqual([
      {
        name: 'judge(Names the API to use)',
        passed: true,
        score: 0.9,
        message: '0.90 (threshold 0.7): It shows the API.',
      },
      {
        name: 'judge(Cites a source)',
        passed: true,
        score: 0.4,
        message: '0.40 (threshold 0.3): No source.',
      },
    ]);
    expect(passed).toBe(true);
    expect(score).toBeCloseTo(0.65);
    expect(judge.prompts[0]).toContain('Discriminated unions in zod?');
    expect(judge.prompts[0]).toContain('docs (completed)');
    expect(judge.prompts[0]).toContain('Use z.discriminatedUnion.');
  });

  it('fails a judge check when the judge fails, rather than skipping it', async () => {
    const agent = new FakeAgent();
    const report = await evaluate({
      agent,
      sandbox,
      judge: judgeModel(new Error('Overloaded')),
      cases: [{ name: 'judged', prompt: 'Hi', expect: { judge: 'Is polite' } }],
    });

    const [judged] = report.cases[0]!.trials[0]!.checks;
    expect(judged).toMatchObject({ passed: false, score: 0 });
    expect(judged!.message).toContain('Overloaded');
  });

  it('runs a check of your own on what the case observed', async () => {
    const agent = new FakeAgent();
    agent.script = [{ chunks: [...call('a', {}), ...call('b', {}), ...say('ok')] }];

    const report = await evaluate({
      agent,
      sandbox,
      cases: [
        {
          name: 'order',
          prompt: 'Go',
          expect: { includes: 'ok' },
          check: (run) => ({
            passed: run.toolCalls.map(({ name }) => name).join() === 'b,a',
            message: 'b must come first',
          }),
        },
      ],
    });

    expect(report.cases[0]!.trials[0]!.checks.at(-1)).toEqual({
      name: 'check',
      passed: false,
      score: 0,
      message: 'b must come first',
    });
  });

  it('runs every trial, and passes a case on its pass rate', async () => {
    const agent = new FakeAgent();
    agent.script = [{ chunks: say('yes') }, { chunks: say('no') }, { chunks: say('yes') }];
    const cases = [{ name: 'yes', prompt: 'Say yes', expect: { includes: 'yes' } }];

    const strict = await evaluate({ agent, sandbox, trials: 3, cases });
    expect(strict.cases[0]).toMatchObject({ passed: false, passRate: 2 / 3 });
    expect(agent.sessions).toHaveLength(3);

    agent.script = [{ chunks: say('yes') }, { chunks: say('no') }, { chunks: say('yes') }];
    const lenient = await evaluate({ agent, sandbox, trials: 3, minPassRate: 0.6, cases });
    expect(lenient.passed).toBe(true);
  });

  it('fails a trial that cannot run to its end, and still destroys its session', async () => {
    const agent = new FakeAgent();
    agent.script = [{ fail: new Error('Bridge lost') }];

    const report = await evaluate({ agent, sandbox, cases: [{ name: 'lost', prompt: 'Hi' }] });

    expect(report.cases[0]!.trials[0]).toMatchObject({
      error: 'Bridge lost',
      passed: false,
      score: 0,
      checks: [],
    });
    expect(agent.sessions[0]!.destroyed).toBe(true);
  });

  it('times a trial out', async () => {
    const agent = new FakeAgent();
    agent.script = [{ hang: true }];

    const report = await evaluate({
      agent,
      sandbox,
      timeoutMs: 20,
      cases: [{ name: 'slow', prompt: 'Hi' }],
    });

    expect(report.cases[0]!.trials[0]!.error).toMatch(/^Timed out/);
  });

  it('tells about each case as it ends', async () => {
    const agent = new FakeAgent();
    const ended: string[] = [];

    await evaluate({
      agent,
      sandbox,
      cases: [
        { name: 'one', prompt: '1' },
        { name: 'two', prompt: '2' },
      ],
      onCaseEnd: ({ name }) => ended.push(name),
    });

    expect(ended).toEqual(['one', 'two']);
  });

  it.each([
    [{ cases: [] }, 'There is no case to run.'],
    [
      {
        cases: [
          { name: 'a', prompt: 'x' },
          { name: 'a', prompt: 'y' },
        ],
      },
      'Case "a": Another case',
    ],
    [{ cases: [{ name: 'a', prompt: [] }] }, 'Every prompt must say something.'],
    [
      { cases: [{ name: 'a', prompt: 'x', expect: { judge: 'Polite' } }] },
      'give `evaluate()` a `judge`',
    ],
    [{ trials: 0, cases: [{ name: 'a', prompt: 'x' }] }, '`trials` must be'],
    [{ minPassRate: 2, cases: [{ name: 'a', prompt: 'x' }] }, '`minPassRate` must be'],
    [{ cases: [{ name: 'a', prompt: 'x', expect: { include: 'y' } }] }, '`expect.include` is no'],
    [{ cases: [{ name: 'a', prompt: 'x', expect: { includes: { regex: '(' } } }] }, 'includes'],
    [{ cases: [{ name: 'a', prompt: 'x', expect: { calledTools: 'bash' } }] }, 'list of tool'],
    [{ cases: [{ name: 'a', prompt: 'x', expect: { maxToolCalls: -1 } }] }, 'whole number'],
    [{ cases: [{ name: 'a', prompt: 'x', harnesses: 'codex' }] }, '`harnesses` must be'],
    [{ concurrency: 2, cases: [{ name: 'a', prompt: 'x' }] }, 'one sandbox runs one trial'],
  ])('refuses cases that cannot run before running any: %j', async (settings, message) => {
    const agent = new FakeAgent();

    // Cases as JSON may hold anything: some of these are wrong on purpose.
    const cases = settings as unknown as Pick<EvaluateSettings, 'cases'>;
    const error = await evaluate({ agent, sandbox, ...cases }).catch((caught: unknown) => caught);

    expect(InvalidEvalError.isInstance(error)).toBe(true);
    expect((error as Error).message).toContain(message);
    expect(agent.sessions).toEqual([]);
  });

  it('reads a pattern written as JSON', async () => {
    const agent = new FakeAgent();
    agent.script = [{ chunks: say('feat(api): add the route') }];

    const report = await evaluate({
      agent,
      sandbox,
      cases: [
        {
          name: 'commit',
          prompt: 'Draft it',
          expect: { includes: { regex: '^FEAT\\(', flags: 'i' }, excludes: [{ regex: '\\(\\)' }] },
        },
      ],
    });

    expect(report.cases[0]!.trials[0]!.checks.map(({ name, passed }) => [name, passed])).toEqual([
      ['includes(/^FEAT\\(/i)', true],
      ['excludes(/\\(\\)/)', true],
    ]);
  });

  it('skips the cases made for other runtimes', async () => {
    const agent = new FakeAgent();
    const ended: string[] = [];

    const report = await evaluate({
      agent,
      sandbox,
      harness: 'codex',
      cases: [
        { name: 'hook', prompt: 'x', harnesses: ['claude-code'], expect: { includes: 'never' } },
        { name: 'any', prompt: 'y' },
      ],
      onCaseEnd: ({ name }) => ended.push(name),
    });

    expect(report.passed).toBe(true);
    expect(report.cases[0]).toMatchObject({
      name: 'hook',
      skipped: 'made for claude-code, not codex',
      trials: [],
    });
    expect(agent.prompts).toEqual(['y']);
    expect(ended).toEqual(['hook', 'any']);
  });

  it('runs trials at once on sandboxes that hold several, each with a lease of its own', async () => {
    const agent = new FakeAgent();
    agent.script = Array.from({ length: 4 }, () => ({ delayMs: 30, chunks: say('ok') }));
    const sandboxes = fakeSandboxes(2);

    const report = await evaluate({
      agent,
      sandbox: sandboxes,
      trials: 2,
      cases: [
        { name: 'one', prompt: '1', expect: { includes: 'ok' } },
        { name: 'two', prompt: '2', expect: { includes: 'ok' } },
      ],
    });

    expect(report.passed).toBe(true);
    expect(report.cases.map(({ name, trials }) => [name, trials.length])).toEqual([
      ['one', 2],
      ['two', 2],
    ]);
    expect(sandboxes.peak).toBe(2);
    const acquired = sandboxes.events.filter((event) => event.startsWith('acquire'));
    expect(acquired).toHaveLength(4);
    expect(sandboxes.events.filter((event) => event.startsWith('close'))).toHaveLength(4);
    // The session of each trial is the one its lease was acquired for.
    expect(agent.sessions.map(({ id }) => `acquire ${id}`).sort()).toEqual([...acquired].sort());
  });

  it('refuses more trials at once than the sandboxes hold', async () => {
    const error = await evaluate({
      agent: new FakeAgent(),
      sandbox: fakeSandboxes(2),
      concurrency: 3,
      cases: [{ name: 'a', prompt: 'x' }],
    }).catch((caught: unknown) => caught);

    expect(InvalidEvalError.isInstance(error)).toBe(true);
    expect((error as Error).message).toContain('hold 2 session(s) at once');
  });
});
