---
'ai-sdk-harness-approval': patch
---

`ai-sdk-harness-approval/describe` exports what reads a tool call — `describeToolCall`, `commandOf`, `pathsOf`, `toolKindOf`, `commandSegments` — with no peer dependency, not even for its types: `ai` and `@ai-sdk/harness` are now optional peer dependencies, for an interface that only shows approval requests.
