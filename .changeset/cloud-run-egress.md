---
'ai-sdk-sandbox-cloud-run': patch
---

The egress proxy takes the credentials it puts in a request out of the response headers, so an API echoing them back never hands them to the sandbox, and refuses the NAT64 and 6to4 IPv6 addresses that carry a private IPv4 one, the metadata server's included. The service warns when it starts with `SANDBOX_ALLOW_EGRESS`, whose network bypasses the proxy.
