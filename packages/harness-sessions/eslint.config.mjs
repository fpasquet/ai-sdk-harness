// @ts-check
import { notFrom, restrictImports } from '@repo/eslint-config/boundaries';
import nodeConfig from '@repo/eslint-config/node';

/**
 * The layers of the package, each importing only the ones below it: `utils/` and `definitions/`
 * (types and constants) are leaves, then `errors/` ← `store/`, `sandboxes/` and `turns/`, beside
 * each other ← `manager/`.
 */
const MIDDLE = ['store', 'sandboxes', 'turns'];
const LAYERS = [
  ['errors', [...MIDDLE, 'manager']],
  ...MIDDLE.map((layer) => [layer, [...MIDDLE.filter((other) => other !== layer), 'manager']]),
];

export default [
  ...nodeConfig(import.meta.dirname),
  restrictImports({
    files: ['src/utils/**/*.ts', 'src/definitions/**/*.ts'],
    patterns: [
      {
        regex: '^\\.\\./',
        message: 'utils/ and definitions/ are leaves: they import nothing of the package.',
      },
    ],
  }),
  ...LAYERS.map(([layer, above]) =>
    restrictImports({
      files: [`src/${layer}/**/*.ts`],
      patterns: [
        notFrom(
          /** @type {string[]} */ (above),
          `${layer}/ may not import ${/** @type {string[]} */ (above).join('/, ')}/: they sit above it or beside it.`,
        ),
      ],
    }),
  ),
];
