---
'ai-sdk-sandbox-gce': patch
---

The egress proxy only reaches global unicast IPv6 addresses (`2000::/3`), rather than every address outside a list of private ranges. IPv4-compatible addresses (`::169.254.169.254`), local-use NAT64 (`64:ff9b:1::/48`), Teredo (`2001::/32`), site-local (`fec0::/10`) and documentation addresses are refused, along with the private ranges refused already. None of them was reachable from a proxy on an IPv4-only network, as Google Cloud VPCs are by default. A dual-stack network could have reached them.
