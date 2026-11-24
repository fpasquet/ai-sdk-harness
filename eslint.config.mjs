// @ts-check
import nodeConfig from '@repo/eslint-config/node';

export default [
  // Outside the workspace, its dependencies are not installed here: CI type-checks it on its own.
  { ignores: ['examples/starter/**'] },
  ...nodeConfig(import.meta.dirname),
];
