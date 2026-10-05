# Maintainers guide

Everything needed to release, automate, and administer this monorepo. Day-to-day contributor guidance lives in [CONTRIBUTING.md](CONTRIBUTING.md); this file is for maintainers.

## Tooling at a glance

| Concern            | Tool                              | Entry point                                        |
| ------------------ | --------------------------------- | -------------------------------------------------- |
| Task orchestration | Turborepo                         | `turbo.json` (always via root `pnpm` scripts)      |
| Versioning/publish | Changesets                        | `.changeset/config.json`, `release.yml`            |
| Git hooks          | Husky + lint-staged + commitlint  | `.husky/`, `*.config.mjs`                          |
| Lint/format/types  | `@repo/*` presets                 | `packages/configs/*`                               |
| Tests              | Vitest (`@repo/vitest-config`)    | `vitest.config.ts`, `vitest.e2e.config.ts`         |
| Package gates      | publint, `npm pack` dry-run, attw | `pnpm publint` / `pnpm pack:dry-run` / `pnpm attw` |
| Docs site          | Fumadocs (Next.js)                | `docs/`, deployed by Vercel's Git integration      |

## Quality gates

Mandatory before delivery (also enforced in CI):

```bash
pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

When a publishable package's manifest or public exports change, also run the publish gates:

```bash
pnpm publint        # manifest / exports correctness
pnpm pack:dry-run   # what actually ends up in the tarball
pnpm attw           # Are the Types Wrong? ESM-only type resolution
```

The e2e suite needs Docker Sandboxes, which GitHub-hosted runners do not have: run it locally before releasing a change to how a package drives `sbx`.

```bash
pnpm test:e2e
```

CI maps the rest to workflows: **CI** (`ci.yml`: check + a Node 24/26 test matrix, with an aggregate `CI` gate), **Quality** (`quality.yml`: publint + pack + attw), **CodeQL** (`codeql.yml`, informational), plus **Validate commit messages** and **Semantic PR title** gates. Require `CI`, `Package quality checks`, `Validate commit messages`, and `Semantic PR title` in the branch ruleset.

## Releasing

Releases run in **CI** from `main` via `changesets/action` (`release.yml`).

### Releases

1. Merge PRs, each carrying a `pnpm changeset`.
2. The release workflow opens/updates a version PR titled `chore(release): version packages` (runs `pnpm version-packages`, i.e. `changeset version`).
3. Merging that PR publishes every bumped package with the `latest` dist-tag, tags it and cuts a GitHub release.

Packages are versioned independently: only the packages that changed are released.

### First publish of a new package

npm trusted publishing (OIDC) is declared per package on npmjs.com, and the package has to exist there before a trusted publisher can be attached to it. The very first version is therefore published by hand, from the `fpasquet` npm account:

```bash
npm whoami                                   # fpasquet
pnpm changeset version                       # consumes the pending changesets, e.g. 0.0.0 → 0.1.0
pnpm --filter ai-sdk-sandbox-sbx build
pnpm --filter ai-sdk-sandbox-sbx publish --access public --no-provenance
git commit -am "chore(release): ai-sdk-sandbox-sbx@0.1.0" && git tag ai-sdk-sandbox-sbx@0.1.0
```

Provenance needs a CI identity, hence `--no-provenance` from a laptop. Then, on npmjs.com, open the package's **Settings → Trusted publishing** and declare GitHub Actions, repository `fpasquet/ai-sdk-harness`, workflow `release.yml`. Every release after that goes through CI, with provenance and no token at all.

Before choosing the name of a new package, check it is free:

```bash
npm view <name>   # E404 means it is free
```

### Versioning policy

The packages are in their **0.x** series: they are released to be tried, and their API settles with that feedback before a 1.0.0. Until then, breaking changes ship as a **minor** with a `BREAKING:` note in the changeset body, everything else as a **patch**. A `major` changeset releases 1.0.0: only add one to take that step, once the API has held for a while. When `@ai-sdk/harness` breaks its `HarnessV1` interfaces, the packages follow in their next minor.

From 1.0.0 on, breaking changes ship as a **major**. A feature documented as experimental (the cloud mode of `ai-sdk-sandbox-sbx`) may still change in a `minor`: say so in the changeset.

There is no alpha or beta channel: the 0.x series is where the packages get tried. Review the `chore(release): version packages` PR before merging it: that diff is the deliberate gate on what actually ships.

## Repository automation

### One-time GitHub setup

- **Settings → General**: allow squash merging only, with the PR title as the commit message; enable auto-merge and automatic deletion of head branches.
- **Settings → Rules**: a ruleset on `main` requiring the status checks above and a pull request.
- **Settings → Actions → General**: workflow permissions _Read and write_, and _Allow GitHub Actions to create and approve pull requests_ (the release PR).
- **Settings → Secrets**: `CODECOV_TOKEN`, optional (the coverage upload is skipped without it).

### Labels (declarative, auto-synced)

Edit `.github/labels.yml` and open a PR. On merge to `main`, `repo-config.yml` syncs them. Manual run: **Actions → Repository config → Run workflow**, with **prune-labels** to delete labels not declared there.

### PR auto-labelling

`pr-labeler.yml` (+ `.github/labeler.yml`) applies `scope:*` and `package:*` labels from the changed paths. A new package needs a mapping in `labeler.yml` and a label in `labels.yml`.

### Dependabot

`dependabot.yml` groups npm and GitHub Actions updates; `dependabot-auto-merge.yml` auto-approves and squash-merges patch/minor bumps. `@ai-sdk/*` packages are grouped together: the harness and its adapters move in lockstep.

## Docs deployment

`docs/` is a standalone Fumadocs (Next.js) app, deployed by **Vercel's Git integration** with `docs` as the root directory. There is no workflow for it in this repo. Set `NEXT_PUBLIC_SITE_URL` to the production URL. Validate locally with `pnpm docs:build`.
