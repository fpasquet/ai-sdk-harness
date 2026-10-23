---
'ai-sdk-harness-plugins': minor
---

`@ai-sdk/mcp` is now an optional peer dependency, as the other `@ai-sdk/*` packages are: install it beside `ai-sdk-harness-plugins` when your server connects to MCP servers itself — an `http` or `stdio` server without `runIn: 'sandbox'` — and you pass no `connectMcpServer`. An application whose MCP servers all run in the sandbox no longer installs it, and one that uses it picks its version, in step with its `ai` and `@ai-sdk/provider-utils`, rather than getting a second copy of them. Without it, `resolvePlugins()` and `catalog.resolve()` fail with an error that says to install it or to pass `connectMcpServer`, instead of the loader's. Its imports are hidden from webpack and Turbopack, so that an application without it still builds; a build that copies only the files it traces, such as Next.js's `output: 'standalone'` with Turbopack, may leave it out: pass your own `connectMcpServer` there.
