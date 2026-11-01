---
'ai-sdk-harness-approval': minor
---

A command that writes to a file through a redirection is decided as an edit of that file: it is only as allowed as the command and the edit rules for the file, and no longer asked about whatever the rules say. `make e2e > /tmp/e2e.txt 2>&1` is allowed under a policy that allows `make e2e` and the edit of `/tmp/e2e.txt`, as a sandbox's policy with `edits: { deny: ['.git/**'], default: 'allow' }` does, where it was denied for want of a person to ask; `ls > .env` is denied when edits of `.env*` are. A file the shell names only as it runs, `> "$OUT"` or `> ~/out`, is still asked about.
