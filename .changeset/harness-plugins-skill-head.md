---
'ai-sdk-harness-plugins': patch
---

`loadClaudeCodePlugin()` keeps the head of each `SKILL.md`, as the [Agent Skills specification](https://agentskills.io/specification) writes it, rather than its name and description alone: a skill now has `version` (its `version`, or `metadata.version`), `license`, `compatibility`, `allowedTools` (`allowed-tools`, as a list: separated by spaces or commas, never within `Bash(git status:*)`) and `metadata`, each when the file gives it. Your application can show a skill's license, or take its version when it imports it. `PluginSkill` declares them, `definePlugin()` and `defineItem()` accept them, and `withPlugins()` hands the runtime what it did before: the name, the description, the content and the files.
