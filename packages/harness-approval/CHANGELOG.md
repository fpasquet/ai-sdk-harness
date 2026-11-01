# ai-sdk-harness-approval

## 0.2.0

### Minor Changes

- 142ca6e: A command that writes to a file through a redirection is decided as an edit of that file: it is only as allowed as the command and the edit rules for the file, and no longer asked about whatever the rules say. `make e2e > /tmp/e2e.txt 2>&1` is allowed under a policy that allows `make e2e` and the edit of `/tmp/e2e.txt`, as a sandbox's policy with `edits: { deny: ['.git/**'], default: 'allow' }` does, where it was denied for want of a person to ask; `ls > .env` is denied when edits of `.env*` are. A file the shell names only as it runs, `> "$OUT"` or `> ~/out`, is still asked about.

## 0.1.2

### Patch Changes

- 7575a9e: The body of a here-document is no longer read as commands: `python3 - <<'EOF'` followed by a script whose text holds `>=` or `@>` is no longer taken for a command that writes to a file, nor are its lines held to the command rules. A redirection on the line of the here-document, `cat > notes.md <<'EOF'`, still writes, and the substitutions of a body whose delimiter is unquoted still count as commands. The reason given for a command that writes to a file now names the file: "`cat` writes to `notes.md`.". `CommandSegment` gains `files`, the files its redirections write to.

## 0.1.1

### Patch Changes

- 13ede93: A policy that never asks a person can be held by the sandbox itself, with Claude Code: `installClaudeCodePolicies(sandbox, { name: policy })`, from the new `ai-sdk-harness-approval/sandbox` entry, installs a `PreToolUse` hook in Claude Code's managed settings, root's files the agent cannot change, and `policy.claudeCodeSandbox(name)` gives the settings of `createClaudeCode()` and `HarnessAgent` for an agent held to it. Each command and edit is allowed or denied before Claude Code runs it, the agent told why: the turn never pauses for an approval, which also keeps clear of two bugs of the Claude Code harness around approvals (vercel/ai#23499, vercel/ai#23503).

## 0.1.0

### Minor Changes

- 05ff36c: First release: a person in the loop of AI SDK harness agents. `defineApprovalPolicy()` reads an approval policy, the same for every harness: shell commands allowed, asked about or denied by prefix — each command of a chain and of a substitution held to the rules, a redirection to a file never allowed —, file edits by path glob, tools by name, and a default for the rest. `agentSettings(harness)` gives a `HarnessAgent` the `permissionMode` and `toolApproval` that make it ask what the policy decides, `warnings(harness)` what a harness that cannot ask (Codex) does not follow, `evaluate()` what it makes of one call, `answer()` the responses a route continues a turn with, and `approver()` the `approve` option of `ai-sdk-harness-sessions`, which answers within the turn. "Always allow" for the rest of a session comes from `suggestGrant()`, kept with `withGrants()`: a grant allows what the policy would ask about, never what it denies. `describeToolCall()` tells what a call does for a person to approve it, and `answersOf()`, `isComplete()` and `describeAnswers()` answer the agent's questions, `askUserQuestions`. It runs in the browser too, for the `ToolApproval` and `QuestionsForm` components of the registry of the documentation.
