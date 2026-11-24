---
'ai-sdk-harness-sessions': patch
---

`createFileSessionStore(directory)`, from the new `ai-sdk-harness-sessions/file` entry, keeps sessions in JSON files, so that they outlive a restart with nothing to install: for a prototype, a demo, or an application on one machine. Each session is `<id>.json`, and `<id>.resume.json` while it is suspended; the directory and its files are readable by their owner alone, and each file is written whole, then renamed over the old one, so a process stopped in the middle leaves the previous version. It gives no lease methods: one manager per directory.
