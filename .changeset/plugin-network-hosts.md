---
'ai-sdk-harness-plugins': patch
---

A plugin, or an item on its own, can declare the hosts it reaches that its definition does not show — the API a stdio MCP server started with `npx` calls, the web service a hook posts to — as `network: { hosts: ['api.example.com', '*.example.com'] }`. `definePlugin()` and `defineItem()` refuse a host that is not a host name or a `*.<domain>` wildcard, the notation of `allowedHosts` in a sandbox's network policy.

`resolvePlugins()` and `catalog.resolve()` return `hosts` beside the `plugins`: the hosts the plugins reach, unique and sorted — the host of each `http` tool and `http` MCP server, and the declared ones, what a selection requires included. `pluginHosts(plugins)` reads the same of plugins before they are resolved. A sandbox that lets only some hosts through knows what to allow for them.
