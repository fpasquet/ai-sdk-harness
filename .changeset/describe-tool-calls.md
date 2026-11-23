---
'ai-sdk-harness-approval': patch
---

`describeToolCall()` shows what each built-in tool acts on rather than its input as JSON: the file of `Read`, the pattern of `Glob` and `Grep`, the URL of `WebFetch`, the query of `WebSearch`, the notebook of `NotebookEdit`; a tool it does not know whose input carries a `command`, an MCP server's for instance, is shown as a command. Its summary gains `action`, what the call does as a key with no text (`run-command`, `read-file`, `fetch-url`…), and it takes `titles`, the titles in your language by action (`TOOL_CALL_TITLES` holds the English ones), and `maxDetail`, the length the detail is cut at (400 by default). `commandOf()` and `pathsOf()`, what it reads a call with, are exported.
