---
'ai-sdk-harness-evals': minor
---

First release: evals for AI SDK harness agents. `evaluate({ agent, sandbox, cases })` runs each case on any `HarnessAgent` — Claude Code, Codex or another runtime — in a new session of the sandbox, answers the tool approvals a turn pauses on, and checks what the agent did: the text of its answer (`includes`, `excludes`), the tools it called and how each call ended (`calledTools`, `notCalledTools`, `maxToolCalls`, `noToolErrors`), the skills it loaded (`loadedSkills`), and criteria a `judge` model scores from 0 to 1. A case is plain data — a name, a prompt or the prompts of several turns, and its expectations —, with a `check` of your own for the rest; a runtime's own tools match whatever it names them, `bash` being Claude Code's `Bash` and Codex's `shell`. Given `plugins`, the cases' `/commands` are expanded as your application would.

`trials` runs each case several times and `minPassRate` says how many must pass. The `EvalReport` keeps, for every trial, the conversation, the tool calls with their input and output, the checks and the tokens; `formatReport()` prints it, and `compareReports()` sets two reports of the same cases side by side — the agent without a plugin and with it, two models, two runtimes —, with what each case gained or lost. `InvalidEvalError` refuses cases that cannot run before any does.
