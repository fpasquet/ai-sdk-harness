---
'ai-sdk-harness-plugins': patch
---

A plugin, or an item on its own, can carry what it promises as eval cases: `evals`, a list of `{ name, prompt, expect, harnesses, trials, tags }` written in the same manifest, or in `definePlugin()`. `definePlugin()`, `defineItem()` and their JSON Schemas check them; `catalog.entries()` gives each entry its own. They never reach the agent, `describe()` nor `fingerprint()`: editing a case rebuilds no agent. `evaluateCatalog()` of `ai-sdk-harness-evals` runs them.
