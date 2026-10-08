// @ts-check
import { notFrom, restrictImports, sandboxClientLayers } from '@repo/eslint-config/boundaries';
import nodeConfig from '@repo/eslint-config/node';

/** Anything but a Node.js built-in or a relative import. */
const PACKAGE = '^(?!node:|\\.)';

export default [
  ...nodeConfig(import.meta.dirname),
  // The client and the service only share src/protocol/.
  ...sandboxClientLayers('src/client', [
    notFrom(['server', 'in-sandbox'], 'The client shares nothing with the service but protocol/.'),
  ]),
  restrictImports({
    files: ['src/server/**/*.ts'],
    patterns: [
      notFrom(
        ['client', 'in-sandbox'],
        'The service shares nothing with the client but protocol/.',
      ),
    ],
    // The service has no runtime dependency.
    paths: ['@ai-sdk/harness', '@ai-sdk/provider-utils'].map((name) => ({
      name,
      allowTypeImports: true,
      message: 'The service has no runtime dependency: type imports only.',
    })),
  }),
  // Run inside the sandboxes, with the image's Node.js.
  restrictImports({
    files: ['src/in-sandbox/**/*.ts'],
    ignores: ['**/*.spec.ts'],
    patterns: [
      { regex: '^\\.(?!\\./protocol/)', message: 'in-sandbox/ imports nothing but protocol/.' },
      { regex: PACKAGE, message: 'in-sandbox/ runs with the bare Node.js of the sandbox image.' },
    ],
  }),
  // The contract between the client, the service and the sandboxes.
  restrictImports({
    files: ['src/protocol/**/*.ts'],
    ignores: ['**/*.spec.ts'],
    patterns: [
      { regex: '^\\.\\./', message: 'protocol/ is shared by every side: it imports none of them.' },
      { regex: PACKAGE, message: 'protocol/ has no dependency.' },
    ],
  }),
];
