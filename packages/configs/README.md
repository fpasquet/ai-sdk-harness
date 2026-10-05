# Shared presets

Private `@repo/*` workspace packages, consumed with `workspace:*` and never published. Extend them
rather than duplicating their options downstream.

| Package                   | What it provides                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------ |
| `@repo/build`             | `repo-build` (clean `dist`, compile with `tsc -p tsconfig.build.json`), `repo-clean` |
| `@repo/eslint-config`     | `base` (framework-agnostic), `node` (type-aware, ESM packages), `nextjs`             |
| `@repo/prettier-config`   | The Prettier options                                                                 |
| `@repo/typescript-config` | `base.json`, `library.json` (ESM packages, `nodenext`), `nextjs.json`                |
| `@repo/vitest-config`     | `vitestConfig()`: the Vitest preset, coverage thresholds included                    |
