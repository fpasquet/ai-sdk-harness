---
'ai-sdk-sandbox-gce': patch
---

The egress proxy reads the ClientHello of every `CONNECT` tunnel, and cuts the tunnel unless the TLS names the host it was opened to (SNI). A sandbox allowed one host behind a CDN, such as `registry.npmjs.org` behind Cloudflare, could open a tunnel to it and then name any other site served by the same CDN, a server of its own included. A tunnel to an IP address must name no server. A client that sends something other than TLS through a tunnel is cut too.
