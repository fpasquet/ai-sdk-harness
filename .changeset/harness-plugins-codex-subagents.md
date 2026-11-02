---
'ai-sdk-harness-plugins': minor
---

Codex takes the plugins' subagents: `withPlugins()` writes each one as a Codex agent file, `.codex/agents/<name>.toml` in the session's working directory, with its `instructions` as `developer_instructions` and its `model` unless it is `inherit` or a Claude Code alias. A Codex subagent has the main agent's tools: Codex has no list of tools per agent, and the subagent's `tools` are left out.

BREAKING: on Codex, a plugin's subagents are no longer left out, nor reported to `onUnsupported`, and the catalog no longer lists `codex` in their `unsupportedOn`.
