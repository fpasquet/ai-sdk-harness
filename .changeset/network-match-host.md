---
'ai-sdk-harness-network': patch
---

`matchesHost(hosts, host, options?)` says whether a host matches a list of hosts: a name listed as it is, or a subdomain of a `*.<domain>` entry, case and a final dot ignored. A wildcard covers the subdomains only by default, the narrowest reading of the sandboxes; `wildcardMatchesDomain: true` makes `*.example.com` cover `example.com` too.
