---
'ai-sdk-sandbox-gce': patch
---

The egress proxy caps the connections each sandbox holds open through it at once: 128 by default, `SANDBOX_PROXY_MAX_CONNECTIONS` to change it. One connection beyond the cap is cut, and the first one cut is logged. A single sandbox could otherwise take every socket of the proxy, and cut the network of all the others. The proxy's systemd unit in the README raises its open file limit to match (`LimitNOFILE=65536`): add the line to yours.
