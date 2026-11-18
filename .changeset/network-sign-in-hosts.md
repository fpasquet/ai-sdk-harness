---
'ai-sdk-harness-network': patch
---

`harnessHosts(harnessId, { signIn: true })` adds where the runtime signs in with a subscription and refreshes its token, for a runtime run with its own login in the sandbox rather than a token brokered from your server: `claude.ai` and `platform.claude.com` for Claude Code, in `HARNESS_NETWORK['claude-code'].signIn`.
