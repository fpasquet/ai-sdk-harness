# ai-sdk-harness-evals

<p align="center">
  <a href="https://www.npmjs.com/package/ai-sdk-harness-evals"><img alt="npm" src="https://img.shields.io/npm/v/ai-sdk-harness-evals" /></a>
  <a href="https://github.com/fpasquet/ai-sdk-harness/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/fpasquet/ai-sdk-harness/actions/workflows/ci.yml/badge.svg" /></a>
  <img alt="Node &gt;= 24" src="https://img.shields.io/badge/node-%3E%3D24-3c873a" />
  <img alt="TypeScript strict" src="https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white" />
  <a href="https://github.com/fpasquet/ai-sdk-harness/blob/main/LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg" /></a>
</p>

Evals for [AI SDK harness agents](https://ai-sdk.dev/docs/ai-sdk-harnesses/harness-agent): run Claude Code, Codex and the other runtimes `HarnessAgent` drives on a few cases, **check what they answered and which tools and skills they used**, have a judge model grade what words cannot, and **compare an agent with a plugin and without it** — every plugin and item of a marketplace, from the cases it carries. One function, cases written as data, a report you can read.

## At a glance

```ts
import { HarnessAgent } from '@ai-sdk/harness/agent';
import { evaluate, formatReport } from 'ai-sdk-harness-evals';

const report = await evaluate({
  agent: new HarnessAgent({ harness, model: 'claude-haiku-4-5' }),
  sandbox,
  cases: [
    {
      name: 'names the kernel',
      prompt: 'Which kernel does this machine run?',
      expect: { calledTools: ['bash'], includes: 'Linux' },
    },
  ],
});

console.log(formatReport(report));
// ✓ names the kernel  1/1  score 1.00
//
// 1/1 cases passed · score 1.00 · 14s
```

| Step               | What `evaluate()` does                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------ |
| For each case      | Opens a new session of the agent in the sandbox, sends the case's prompt — or prompts, as turns — then destroys it |
| A turn pauses      | Answers the tool approvals it waits for (approved by default) and lets the turn go on                              |
| The turns are over | Reads what the agent answered, the tools it called and how each call ended, the skills it loaded, the tokens       |
| Then               | Runs the checks of the case's `expect`, the judge's, and yours: the case passes when every check does              |

## Installation

```bash
pnpm add -D ai-sdk-harness-evals
```

`@ai-sdk/harness` and `ai` are peer dependencies; [`ai-sdk-harness-plugins`](https://ai-sdk-harness.pages.dev/docs/packages/harness-plugins) is one too, optional: `evaluate()` needs it only when you give it `plugins`. The agent runs in a real sandbox — any of the sandbox packages, or `@ai-sdk/sandbox-vercel` —, with the credential of its runtime.

## Usage

### Cases

A case is plain data, so cases can live in a JSON file next to your plugins:

```ts
const cases = [
  {
    name: 'answers from the docs',
    prompt: 'How do I declare a discriminated union in zod 4?',
    expect: {
      calledTools: ['context7_query-docs'],
      includes: ['z.discriminatedUnion'],
      excludes: ["I don't know"],
      maxToolCalls: 4,
      noToolErrors: true,
    },
  },
  {
    name: 'remembers across turns',
    // Several prompts are the turns of one session.
    prompt: ['My favourite word is marigold.', 'What is my favourite word?'],
    expect: { includes: /marigold/i },
  },
];
```

| Expectation      | Checks                                                                                              |
| ---------------- | --------------------------------------------------------------------------------------------------- |
| `includes`       | The last answer contains each string, or matches each pattern                                       |
| `excludes`       | It contains none of them                                                                            |
| `calledTools`    | Each tool was called, and at least one call completed                                               |
| `notCalledTools` | None of them was called                                                                             |
| `loadedSkills`   | Each skill was loaded                                                                               |
| `maxToolCalls`   | The case took this many tool calls at most, over all its turns                                      |
| `noToolErrors`   | No tool call ended in an error                                                                      |
| `judge`          | The judge model scores the answer at least at the threshold on each criterion — see [Judge](#judge) |

A pattern is a RegExp in code; in JSON, write its source and flags: `{ "regex": "^feat", "flags": "im" }`. A case made for some runtimes only — a hook, which Codex does not take — says which in `harnesses`, `["claude-code"]`: given the agent's `harness`, `evaluate()` skips it elsewhere, and reports it skipped.

A runtime's own tools match whatever the runtime calls them: `bash` is Claude Code's `Bash` and Codex's `shell`, `edit` is `Edit` and `apply_patch`. Your tools, and an MCP server's, go by the name the stream gives them. A skill is loaded when Claude Code calls its `Skill` tool, or when the agent reads its `SKILL.md`, as Codex does.

For what data cannot say, a case takes a `check` of your own, given everything the case observed:

```ts
{
  name: 'reads before it writes',
  prompt: 'Fix the typo in README.md.',
  check: (run) => {
    const names = run.toolCalls.map(({ name }) => name);
    return names.indexOf('Read') < names.indexOf('Edit');
  },
}
```

### Judge

Give `evaluate()` a `judge` model — any AI SDK language model, never the agent's — for criteria that a string cannot check. It reads each turn's request, the tools called and the answer, and scores the criteria from 0 to 1; a check passes at 0.7, or at the `threshold` you set:

```ts
import { anthropic } from '@ai-sdk/anthropic';

await evaluate({
  agent,
  sandbox,
  judge: anthropic('claude-sonnet-5-5'),
  cases: [
    {
      name: 'explains for a beginner',
      prompt: 'Explain what a git rebase does.',
      expect: {
        judge: [
          'The answer needs no prior knowledge of git internals',
          { criteria: 'The answer warns about rebasing shared branches', threshold: 0.9 },
        ],
      },
    },
  ],
});
```

A judge that fails — a provider error, an answer it cannot parse — fails its check: it is never skipped.

### Evaluating a plugin

Does a plugin make the agent better at what it promises? Run the same cases on the agent without it and with it, then compare:

```ts
import { compareReports, evaluate, formatComparison } from 'ai-sdk-harness-evals';
import { withPlugins } from 'ai-sdk-harness-plugins';

const without = await evaluate({ agent: new HarnessAgent(settings), sandbox, cases });
const withPlugin = await evaluate({
  agent: new HarnessAgent(withPlugins(settings, plugins)),
  sandbox,
  plugins, // expands the cases' /commands, as your application would
  cases,
});

console.log(formatComparison(compareReports(without, withPlugin)));
// names the kernel with its tool  ✗ 0.50 → ✓ 1.00  (+0.50)
// follows the house rule  ✗ 0.50 → ✓ 1.00  (+0.50)
// remembers across turns  ✓ 1.00 → ✓ 1.00  (+0.00)
//
// score +0.33 · 2 improved · 0 regressed
```

The same comparison works for anything else you change: two models, Claude Code and Codex, a reworded command, an item of your marketplace added or not.

### Evaluating a marketplace

The cases of a plugin, or of an item of a marketplace, can live with it: `evals`, in its manifest or in `definePlugin()`, plain data like the rest of it — see [`ai-sdk-harness-plugins`](https://ai-sdk-harness.pages.dev/docs/packages/harness-plugins#eval-cases).

```json
{
  "kind": "tool",
  "name": "npm-latest",
  "type": "http",
  "description": "Read the latest version of an npm package from the registry.",
  "url": "https://registry.npmjs.org/{name}/latest",
  "evals": [
    {
      "name": "reads the latest version from the registry",
      "prompt": "What is the latest version of the zod package on npm? Use a tool.",
      "expect": { "calledTools": ["npm-latest"], "noToolErrors": true }
    }
  ]
}
```

`evaluateCatalog()` runs the cases of every entry that has some on the agent with it — what it requires included — and on the agent without it, then sets the two side by side:

```ts
import { evaluateCatalog, formatCatalogReport } from 'ai-sdk-harness-evals';
import { withPlugins } from 'ai-sdk-harness-plugins';

const report = await evaluateCatalog({
  catalog,
  // The agent with an entry's plugins; with none, the baseline.
  agent: (plugins) => new HarnessAgent(withPlugins({ harness, model }, plugins)),
  sandbox,
  harness: 'claude-code', // skips the cases made for other runtimes
});

console.log(formatCatalogReport(report));
// ── command:npm
// ✓ /npm sizes a package up from the registry  1/1  score 1.00
//
// 1/1 cases passed · score 1.00 · 3m29s
//
// without it → with it
// /npm sizes a package up from the registry  ✗ 0.00 → ✓ 1.00  (+1.00)
// …
// 9/12 entries passed · 9/12 better than without them
```

`only` evaluates the entries you name, by catalog id; `baseline: false` skips the runs without them. The other settings are those of `evaluate()`.

### Several trials at once

One sandbox runs one trial at a time: each holds the sandbox's bridge port. Give `evaluate()` or `evaluateCatalog()` the sandboxes of [`ai-sdk-harness-sessions`](https://ai-sdk-harness.pages.dev/docs/packages/harness-sessions) instead, and as many trials run at once as they hold — every trial of every entry for a catalog, each waiting for a place, its timeout starting once it has one:

```ts
import { sandboxPerSession, sharedSandbox } from 'ai-sdk-harness-sessions';

// Views of one sandbox, a port each: four trials at once.
const sandboxes = sharedSandbox({ open: () => sandbox, ports: [4001, 4002, 4003, 4004] });
// Or a sandbox each, destroyed after its trial.
// const sandboxes = sandboxPerSession({ create: (id) => createSandbox(id), maxSessions: 4 });

await evaluate({ agent, sandbox: sandboxes, cases, trials: 5 });
```

`concurrency` runs fewer at once than the sandboxes hold. The sandboxes are yours: shut them down (`sandboxes.shutdown()`) when you are done.

### Trials

Agents are not deterministic: one run of a case says little. `trials` runs each case several times, each in a session of its own; a case passes when the share of its trials that pass reaches `minPassRate`, all of them by default:

```ts
await evaluate({ agent, sandbox, cases, trials: 5, minPassRate: 0.8 });
```

### In a test

`evaluate()` is a function: call it from a script, or from a test of your runner.

```ts
import { expect, it } from 'vitest';

it('keeps the plugin working', { timeout: 600_000 }, async () => {
  const report = await evaluate({ agent, sandbox, cases });
  expect(report.passed, formatReport(report)).toBe(true);
});
```

The report is JSON — but for the RegExps of the cases —: every trial keeps the conversation, the tool calls with their input and output, the checks and the tokens, to write to a file, send to a dashboard, or read when a case fails.

## Reference

| Export                                | What it does                                                                                 |
| ------------------------------------- | -------------------------------------------------------------------------------------------- |
| `evaluate(settings)`                  | Runs the cases on the agent and gives an `EvalReport`                                        |
| `compareReports(baseline, candidate)` | Two reports of the same cases side by side: the score and pass rate each case gained or lost |
| `formatReport(report)`                | A report as text: a line per case, a line per failed check                                   |
| `formatComparison(comparison)`        | A comparison as text                                                                         |
| `evaluateCatalog(settings)`           | Runs the cases of a catalog's plugins and items, with each and without it                    |
| `formatCatalogReport(report)`         | A catalog's report as text                                                                   |

The settings of `evaluate()`: `agent` (a `HarnessAgent`), `sandbox` (the sandbox its sessions run in, or sandboxes), `cases`, and optionally `plugins`, `harness`, `judge`, `trials`, `minPassRate`, `concurrency`, `approvals` (`'approve'` or `'deny'`, for every case or one), `timeoutMs` (a trial's, 5 minutes by default), `onCaseEnd` (called as each case ends) and `abortSignal`. `evaluateCatalog()` takes them too, but for `agent` — a function of the plugins —, `cases` and `plugins`, and adds `catalog`, `only`, `baseline` and `onEntryEnd`.

### Errors

`InvalidEvalError` is thrown before any case runs when the cases cannot run as they are: two cases with one name, an empty prompt, an expectation the package does not know or of the wrong shape, a `judge` expectation without a judge model, more trials at once than the sandboxes hold… Its `case` names the case at fault; its `isInstance()` recognizes it whichever copy of the package threw it.

## Limitations

- **The entries of a catalog are evaluated alone**: each with what it requires, never with the rest of the marketplace.
- **Tool calls are reported by the runtime**: the tools a subagent calls inside its own session are not seen.
- **Approvals are all approved or all denied** within a case; the agent's questions (`AskUserQuestion`) are not answered.

## Development

`pnpm --filter ai-sdk-harness-evals test:e2e` evaluates real Claude Code turns in a Docker Sandbox, without a plugin and with it — a tool run in the sandbox, a rule, a command — and compares the two reports. It needs `sbx` signed in and a Claude credential. See [CONTRIBUTING.md](https://github.com/fpasquet/ai-sdk-harness/blob/main/CONTRIBUTING.md).

## License

[MIT](https://github.com/fpasquet/ai-sdk-harness/blob/main/LICENSE)
