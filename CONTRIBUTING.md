# Contributing

Thanks for contributing.

## Development

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Target a single package:

```bash
pnpm --filter ai-sdk-sandbox-sbx test
```

The unit tests run against a fake `sbx` and need nothing installed. The e2e tests drive the real one: install [Docker Sandboxes](https://docs.docker.com/ai/sandboxes/get-started/) and sign in first:

```bash
pnpm --filter ai-sdk-sandbox-sbx test:e2e   # creates, then removes, sandboxes and a template image
```

Run the example against a real Claude Code agent:

```bash
cp examples/next-chat/.env.example examples/next-chat/.env.local   # set CLAUDE_CODE_OAUTH_TOKEN
pnpm example:dev                                                   # http://localhost:3000
```

Work on the documentation site:

```bash
pnpm docs:dev   # http://localhost:3002
```

Regenerate the screenshots of the example (`docs/public/screenshots/`), after a change to its interface. It builds and starts the example, has Claude Code then Codex answer a prompt in a throwaway sandbox, and captures them with the Chrome installed on your machine:

```bash
pnpm screenshots
```

## Pull requests

Every pull request should include:

- A clear description of the change.
- Tests for behavior changes.
- Documentation updates for public API changes (the package README is what the docs site shows).
- A changeset when a published package changes.

Scope labels (`scope:*` and `package:*`) are applied **automatically** from the changed files. CI runs formatting, lint, typecheck, tests, build, commit-message and PR-title linting, and the package gates (`publint`, `pack:dry-run`, `attw`). Keep the **PR title** a valid Conventional Commit: the repo squash-merges, so the title becomes the commit subject on `main`.

## Changesets

Add a changeset for any user-visible package change:

```bash
pnpm changeset
```

The packages are in their 0.x series, where the minor version carries breaking changes. Use:

- `patch` for fixes, improvements and backward-compatible features.
- `minor` for breaking changes (add a `BREAKING:` note in the changeset body).
- never `major`: it would release 1.0.0, a step the maintainers take on purpose.

## Commit convention

Commits follow [Conventional Commits](https://www.conventionalcommits.org), enforced by commitlint:

```text
feat(sandbox-sbx): publish ports on a fixed host port
fix(sandbox-sbx): keep MCP gateway variables in the sandbox
docs: explain templates
chore(deps): bump turbo
```
