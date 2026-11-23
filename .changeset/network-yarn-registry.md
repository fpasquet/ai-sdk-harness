---
'ai-sdk-harness-network': patch
---

`trustedHosts('yarn-registry')` gives Yarn's registry alone, `registry.yarnpkg.com`, for a project installed with Yarn: `yarn` also opens `repo.yarnpkg.com`, where Corepack downloads Yarn's releases. The new service is in no group, `yarn` holding both.
