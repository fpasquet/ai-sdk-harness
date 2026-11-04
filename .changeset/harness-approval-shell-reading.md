---
'ai-sdk-harness-approval': patch
---

Commands no longer hide from the approval rules. A `<<` that opens no here-document (in a comment, `${…}`, `$[…]`, `((…))`), a here-document whose delimiter or end the scanner cannot read, a `\"` in a quoted redirection target, `$'…'` quotes, a `$((` that closes as a substitution and parentheses in quotes all let a script's next commands go unread, so that `ls # <<EOF` and a second line of `rm -rf /` was allowed. Redirections with no command (`ls; > .env`, `{ ls; } > .env`) and `>&file` now count as edits.

What cannot be read is never allowed: a command whose name the shell only knows as it runs (`$(…)`, `"$TOOL" run`, `$HOME/bin/tool`) and a here-document never closed are asked about, or denied in the sandbox, whatever the rules and the default.
