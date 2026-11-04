---
'ai-sdk-harness-approval': patch
---

Commands no longer hide from the approval rules. A `<<` that opens no here-document (in a comment, `${…}`, `$[…]`, `((…))`), a here-document whose delimiter or end the scanner cannot read, a `\"` in a quoted redirection target, `$'…'` quotes, a `$((` that closes as a substitution and parentheses in quotes all let a script's next commands go unread, so that `ls # <<EOF` and a second line of `rm -rf /` was allowed. Redirections with no command (`ls; > .env`, `{ ls; } > .env`) and `>&file` now count as edits.

What cannot be read matches no rule, and the default decides it: a command whose name the shell only knows as it runs (`$(…)`, `"$TOOL" run`, `$HOME/bin/tool`, read as `tool` until now) and a here-document never closed. Under `default: 'deny'` they are refused, under `default: 'allow'` they run, as any command no rule names.
