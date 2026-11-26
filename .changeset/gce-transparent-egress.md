---
'ai-sdk-sandbox-gce': minor
---

The egress proxy can take the direct connections of programs that ignore `HTTPS_PROXY` and `HTTP_PROXY` (Node.js's own `fetch` without `NODE_USE_ENV_PROXY`, Go, Java…), once the sandboxes' DNS answers its address for every name: TLS on `SANDBOX_PROXY_TLS_PORT` (443), checked by the host its ClientHello names (SNI) and relayed without being decrypted, and plain HTTP on `SANDBOX_PROXY_HTTP_PORT` (80), sent on to its `Host`. Node.js then reaches its hosts without `NODE_USE_ENV_PROXY`, and test suites that mock `fetch` with MSW 3 pass. Nothing changes without these settings. HTTP/3, a TLS connection without SNI, and programs that pin addresses or resolve names elsewhere are not covered.
