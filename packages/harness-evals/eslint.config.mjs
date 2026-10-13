// @ts-check
import { notFrom, restrictImports } from '@repo/eslint-config/boundaries';
import nodeConfig from '@repo/eslint-config/node';

/**
 * The layers of the package, each importing only the ones below it: `definitions/` (types),
 * `errors/` and `utils/` are leaves, then `run/` (drives the agent, reads what it did) ←
 * `checks/` (the expectations and the judge) ← `evaluate/`.
 */
export default [
  ...nodeConfig(import.meta.dirname),
  restrictImports({
    files: ['src/definitions/**/*.ts', 'src/errors/**/*.ts'],
    patterns: [{ regex: '^\\.\\./', message: 'definitions/ and errors/ are leaves.' }],
  }),
  restrictImports({
    files: ['src/utils/**/*.ts'],
    patterns: [
      notFrom(['run', 'checks', 'evaluate', 'errors'], 'utils/ may only import definitions/.'),
    ],
  }),
  restrictImports({
    files: ['src/run/**/*.ts'],
    patterns: [notFrom(['checks', 'evaluate'], 'run/ may not import checks/ or evaluate/.')],
  }),
  restrictImports({
    files: ['src/checks/**/*.ts'],
    patterns: [
      notFrom(['run', 'evaluate'], 'checks/ reads what run/ observed through definitions/.'),
    ],
  }),
];
