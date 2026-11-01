---
'ai-sdk-harness-approval': patch
---

The body of a here-document is no longer read as commands: `python3 - <<'EOF'` followed by a script whose text holds `>=` or `@>` is no longer taken for a command that writes to a file, nor are its lines held to the command rules. A redirection on the line of the here-document, `cat > notes.md <<'EOF'`, still writes, and the substitutions of a body whose delimiter is unquoted still count as commands. The reason given for a command that writes to a file now names the file: "`cat` writes to `notes.md`.". `CommandSegment` gains `files`, the files its redirections write to.
