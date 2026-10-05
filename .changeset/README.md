# Changesets

Every user-visible change to a publishable package (`packages/*`) needs a changeset:

```bash
pnpm changeset
```

Pick the package, the bump and describe the change for the people who install it: the text lands
verbatim in the package's `CHANGELOG.md` and in its GitHub release. The packages are in their 0.x
series: `minor` for a breaking change (with a `BREAKING:` note), `patch` for everything else. Never
`major`, which would release 1.0.0.
The example app, the docs site and the `@repo/*` presets are never published and never need one.

See [MAINTAINERS.md](../MAINTAINERS.md) for how a release goes out.
