// @ts-check
import { notFrom, restrictImports } from '@repo/eslint-config/boundaries';
import nodeConfig from '@repo/eslint-config/node';

/**
 * The layers of the package, each importing only the ones below it: `errors/` and `utils/` are
 * leaves, then `definitions/` ← `commands/` ← `runtimes/` ← `session/` ← `mcp/` ← `config/`,
 * and beside each other at the top, `catalog/`, `loader/` and `agent/`.
 */
const TOP = ['catalog', 'loader', 'agent'];
const LAYERS = [
  ['definitions', ['commands', 'runtimes', 'session', 'mcp', 'config', ...TOP]],
  ['commands', ['runtimes', 'session', 'mcp', 'config', ...TOP]],
  ['runtimes', ['session', 'mcp', 'config', ...TOP]],
  ['session', ['mcp', 'config', ...TOP]],
  ['mcp', ['config', ...TOP]],
  ['config', TOP],
  ...TOP.map((layer) => [layer, TOP.filter((other) => other !== layer)]),
];

export default [
  ...nodeConfig(import.meta.dirname),
  restrictImports({
    files: ['src/errors/**/*.ts', 'src/utils/**/*.ts'],
    patterns: [
      {
        regex: '^\\.\\./',
        message: 'errors/ and utils/ are leaves: they import nothing of the package.',
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
