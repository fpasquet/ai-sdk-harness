---
'ai-sdk-harness-plugins': patch
---

A plugin, or an item on its own, can declare the hosts it reaches that its definition does not show — the API a stdio MCP server started with `npx` calls, the web service a hook posts to — as `network: { hosts: ['api.example.com', '*.example.com'] }`. `definePlugin()` and `defineItem()` refuse a host that is not a host name or a `*.<domain>` wildcard, the notation of `allowedHosts` in a sandbox's network policy.

`resolvePlugins()` and `catalog.resolve()` return `hosts` beside the `plugins`, and `catalog.hosts(selection)` gives them without resolving anything: `{ sandbox, server }`, each unique and sorted, what a selection requires included. `sandbox` is what the sandbox's network policy must let through — the host of each `http` MCP server with `runIn: 'sandbox'`, the registry each `stdio` one with `runIn: 'sandbox'` downloads its package from when a launcher starts it (`npx`, `pnpm dlx`, `bunx`… from the npm registry, `uvx`, `pipx run` from PyPI), and the declared hosts of a plugin or item with anything in the sandbox —, `server` what your server reaches — the host of each `http` tool and of each `http` MCP server it connects to, the registry of each `stdio` one it starts, and the declared hosts of a plugin or item whose parts all run on it. `pluginHosts(plugins)` reads the same of plugins before they are resolved:

```ts
const hosts = catalog.hosts(selection);
const networkPolicy = { mode: 'custom', allowedHosts: [...defaults, ...hosts.sandbox] };
```
