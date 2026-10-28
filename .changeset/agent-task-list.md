---
'ai-sdk-harness-sessions': patch
---

Read the task list the agent keeps while it works. `tasksOf(messages)` replays Claude Code's `TodoWrite`, `TaskCreate` and `TaskUpdate` calls over every turn of a conversation and gives the list as it stands; `createTaskList()` follows it call by call, for a server that reads a turn's chunks. Both come from `ai-sdk-harness-sessions/tasks` too, an entry that runs in the browser, and the docs' registry gains an `AgentTasks` component that shows the list.
