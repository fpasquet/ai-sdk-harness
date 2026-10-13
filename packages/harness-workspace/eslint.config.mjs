// @ts-check
import { notFrom, restrictImports } from '@repo/eslint-config/boundaries';
import nodeConfig from '@repo/eslint-config/node';

/**
 * The layers of the package, each importing only the ones below it: `errors/`, `utils/` and
 * `definitions/` (types) are leaves, then `git/` (what runs in the sandbox) ← `sources/` ←
 * `workspace/`.
 */
const LAYERS = [
  ['git', ['sources', 'workspace']],
  ['sources', ['workspace']],
];

export default [
  ...nodeConfig(import.meta.dirname),
  restrictImports({
    files: ['src/errors/**/*.ts', 'src/utils/**/*.ts', 'src/definitions/**/*.ts'],
    patterns: [
      {
        regex: '^\\.\\./',
        message: 'errors/, utils/ and definitions/ are leaves: they import nothing of the package.',
      },
    ],
  }),
  ...LAYERS.map(([layer, above]) =>
    restrictImports({
      files: [`src/${layer}/**/*.ts`],
      patterns: [
        notFrom(
          /** @type {string[]} */ (above),
          `${layer}/ may not import ${/** @type {string[]} */ (above).join('/, ')}/: they sit above it.`,
        ),
      ],
    }),
  ),
];
