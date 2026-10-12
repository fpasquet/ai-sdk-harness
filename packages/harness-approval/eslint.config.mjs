// @ts-check
import { notFrom, restrictImports } from '@repo/eslint-config/boundaries';
import nodeConfig from '@repo/eslint-config/node';

/** Runs in the browser as well, where a form shows the requests: nothing of Node.js. */
const ISOMORPHIC = {
  regex: '^node:',
  message: 'The package runs in the browser too: no node: imports.',
};

/**
 * The layers of the package, each importing only the ones below it: `definitions/` (types and
 * constants) is a leaf, then `utils/` (shell and path parsing) ← `policy/` ← `describe/`;
 * `questions/` stands beside them.
 */
export default [
  ...nodeConfig(import.meta.dirname),
  restrictImports({
    files: ['src/definitions/**/*.ts'],
    patterns: [
      { regex: '^\\.\\./', message: 'definitions/ is a leaf: it imports nothing of the package.' },
      ISOMORPHIC,
    ],
  }),
  restrictImports({
    files: ['src/utils/**/*.ts'],
    patterns: [
      notFrom(['policy', 'describe', 'questions'], 'utils/ may only import definitions/.'),
      ISOMORPHIC,
    ],
  }),
  restrictImports({
    files: ['src/policy/**/*.ts'],
    patterns: [
      notFrom(['describe', 'questions'], 'policy/ may not import describe/ or questions/.'),
      ISOMORPHIC,
    ],
  }),
  restrictImports({
    files: ['src/describe/**/*.ts', 'src/questions/**/*.ts'],
    patterns: [
      notFrom(['describe', 'questions'], 'describe/ and questions/ stand beside each other.'),
      ISOMORPHIC,
    ],
  }),
  restrictImports({ files: ['src/*.ts'], patterns: [ISOMORPHIC] }),
];
