// @ts-check
import { restrictImports, sandboxClientLayers } from '@repo/eslint-config/boundaries';
import nodeConfig from '@repo/eslint-config/node';

/** Anything but a Node.js built-in or a relative import. */
const PACKAGE = '^(?!node:|\\.)';

export default [
  ...nodeConfig(import.meta.dirname),
  ...sandboxClientLayers('src/client', [
    {
      regex: '^\\.{1,2}/(?:.*/)?in-sandbox/',
      message: 'The client shares nothing with the supervisor but protocol/.',
    },
  ]),
  // Runs inside the sandboxes, copied there with protocol/, with the host's bare Node.js.
  restrictImports({
    files: ['src/in-sandbox/**/*.ts'],
    ignores: ['**/*.spec.ts'],
    patterns: [
      { regex: '^\\.(?!\\./protocol/)', message: 'in-sandbox/ imports nothing but protocol/.' },
      { regex: PACKAGE, message: 'in-sandbox/ runs with the bare Node.js of the host.' },
    ],
  }),
  // The contract between the client and the supervisor.
  restrictImports({
    files: ['src/protocol/**/*.ts'],
    ignores: ['**/*.spec.ts'],
    patterns: [
      { regex: '^\\.\\./', message: 'protocol/ is shared by both sides: it imports neither.' },
      { regex: PACKAGE, message: 'protocol/ has no dependency.' },
    ],
  }),
];
