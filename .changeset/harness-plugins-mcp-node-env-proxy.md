---
'ai-sdk-harness-plugins': patch
---

A stdio MCP server run in the sandbox (`runIn: 'sandbox'`) gets `NODE_USE_ENV_PROXY=1` from `pluginHarnessSettings()`, unless the plugin gives it a value in `env`: a server on Node.js that calls an API with `fetch` keeps leaving through the sandbox's proxy now that the Cloud Run and Compute Engine sandboxes no longer set the variable for every command. On Codex, which starts a stdio server with a few variables of its own only, the server also gets the sandbox's `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY` (lower-case forms included) through `env_vars`: it had no way out of a sandbox before.
