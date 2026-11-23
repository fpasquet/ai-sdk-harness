// @ts-check
import { restrictImports, sandboxClientLayers } from '@repo/eslint-config/boundaries';
import nodeConfig from '@repo/eslint-config/node';

/**
 * The client's layers, as in every sandbox package; and `proxy/`, the egress proxy, which runs in
 * a container of its own with Node.js alone: it imports nothing of the package.
 */
export default [
  ...nodeConfig(import.meta.dirname),
  ...sandboxClientLayers('src'),
  restrictImports({
    files: ['src/proxy/**/*.ts'],
    ignores: ['src/proxy/**/*.spec.ts'],
    patterns: [
      {
        regex: '^\\.\\./',
        message: 'The egress proxy runs alone in its container: it imports nothing of the package.',
      },
      {
        regex: '^(?!node:|\\./)',
        message: 'The egress proxy runs with Node.js alone: nothing but node: modules.',
      },
    ],
  }),
];
