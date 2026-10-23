// @ts-check
import { notFrom, restrictImports } from '@repo/eslint-config/boundaries';
import nodeConfig from '@repo/eslint-config/node';

/** Runs in the browser as well, where a form checks the hosts it is given: nothing of Node.js. */
const ISOMORPHIC = {
  regex: '^node:',
  message: 'The package runs in the browser too: no node: imports.',
};

/**
 * The layers of the package: `errors/` and `presets/` (lists of hosts) are leaves, `hosts/`
 * (checking and merging lists) imports `errors/` only.
 */
export default [
  ...nodeConfig(import.meta.dirname),
  restrictImports({
    files: ['src/errors/**/*.ts', 'src/presets/**/*.ts'],
    patterns: [
      {
        regex: '^\\.\\./',
        message: 'errors/ and presets/ are leaves: they import nothing of the package.',
      },
      ISOMORPHIC,
    ],
  }),
  restrictImports({
    files: ['src/hosts/**/*.ts'],
    patterns: [notFrom(['presets'], 'hosts/ may only import errors/.'), ISOMORPHIC],
  }),
  restrictImports({ files: ['src/*.ts'], patterns: [ISOMORPHIC] }),
];
