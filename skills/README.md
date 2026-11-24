# Agent skills

Installable [agent skills](https://github.com/vercel-labs/skills) that teach your coding agent (Claude Code, Cursor, Codex…) to set up the `ai-sdk-harness` packages in your own application. Each skill is a `SKILL.md` with the `references/` it reads.

## Install

```bash
# Every skill of this repository
npx skills add fpasquet/ai-sdk-harness

# One skill
npx skills add https://github.com/fpasquet/ai-sdk-harness/tree/main/skills/setup-ai-sdk-harness
```

`npx skills` detects the agents installed and puts the skill where each one reads it, in the project by default (`-g` for your user). Then ask your agent, for instance _"run Claude Code in a sandbox from this app"_.

## Skills

| Skill                                                   | What it does                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`setup-ai-sdk-harness`](setup-ai-sdk-harness/SKILL.md) | Set up a `HarnessAgent` end to end: introspect the project, pick the harness and its credential, choose the sandbox the host can run (Docker Sandboxes, microsandbox, srt, Cloud Run, Compute Engine), close its network with `ai-sdk-harness-network`, choose between one session per run and `ai-sdk-harness-sessions`, and run a first turn. |

## Evals

Each skill has an `evals/` folder of manual evaluations: queries and the behaviour expected of the agent. See [`setup-ai-sdk-harness/evals`](setup-ai-sdk-harness/evals/README.md).

## Maintaining them

The skills are written for the users of the packages, from their documentation: a change of an API they show (an option, a function, a default) changes them in the same pull request.
