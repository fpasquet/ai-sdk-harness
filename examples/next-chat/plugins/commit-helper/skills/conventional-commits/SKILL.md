---
name: conventional-commits
description: How to write a commit message following Conventional Commits. Use it whenever you write or review a commit message.
---

# Conventional Commits

A commit message is `<type>(<scope>): <subject>`, then an optional body after a blank line.

- `type` is one of `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `ci`, `perf`.
- `scope` is optional: the part of the code the change is about.
- `subject` is in the imperative mood, lower case, without a final period, 72 characters at most.
- The body says why the change was made, not what the diff already shows.
