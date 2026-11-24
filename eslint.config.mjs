// @ts-check
import nodeConfig from '@repo/eslint-config/node';

export default [
  // Outside the workspace, their dependencies are not installed here: CI checks them on their own.
  { ignores: ['examples/starter/**', 'examples/starter-next/**'] },
  ...nodeConfig(import.meta.dirname),
];
