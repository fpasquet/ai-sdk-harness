---
'ai-sdk-harness-network': patch
---

`isAllowedHost(host, { publicDomain: true })` only takes a name of the public DNS: two labels at least, the last one letters (or an `xn--` one). It refuses `localhost`, a name of one label, an IP address and a numeric extension, which a network policy otherwise takes: what a settings form checks when the sandbox should only reach the Internet.
