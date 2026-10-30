// @ts-check
import { notFrom, restrictImports, sandboxClientLayers } from '@repo/eslint-config/boundaries';
import nodeConfig from '@repo/eslint-config/node';

/** Anything but a Node.js built-in or a relative import. */
const PACKAGE = '^(?!node:|\\.)';

/** The runtimes of the package, each loaded alone by `cli.ts`. */
const RUNTIMES = ['client', 'server', 'proxy', 'in-pod'];

/** A runtime shares nothing with the others but protocol/ and, on the servers' side, common/. */
const alone = (/** @type {string} */ runtime) =>
  notFrom(
    RUNTIMES.filter((other) => other !== runtime),
    `${runtime}/ shares nothing with the other runtimes but protocol/ and common/.`,
  );

/** Type imports only: the servers have no runtime dependency. */
const typesOnly = ['@ai-sdk/harness', '@ai-sdk/provider-utils'].map((name) => ({
  name,
  allowTypeImports: true,
  message: 'The servers have no runtime dependency: type imports only.',
}));

export default [
  ...nodeConfig(import.meta.dirname),
  ...sandboxClientLayers('src/client', [
    notFrom(
      ['server', 'proxy', 'in-pod', 'common'],
      'The client shares nothing with the servers but protocol/.',
    ),
  ]),
  restrictImports({ files: ['src/server/**/*.ts'], patterns: [alone('server')], paths: typesOnly }),
  restrictImports({ files: ['src/proxy/**/*.ts'], patterns: [alone('proxy')], paths: typesOnly }),
  // Runs in every sandbox's pod, with the image's Node.js.
  restrictImports({
    files: ['src/in-pod/**/*.ts'],
    ignores: ['**/*.spec.ts'],
    patterns: [
      alone('in-pod'),
      { regex: PACKAGE, message: 'in-pod/ runs with the bare Node.js of the sandbox image.' },
    ],
  }),
  // What the servers share: Node.js and protocol/ alone.
  restrictImports({
    files: ['src/common/**/*.ts'],
    ignores: ['**/*.spec.ts'],
    patterns: [notFrom(RUNTIMES, 'common/ is shared by the servers: it imports none of them.')],
    paths: typesOnly,
  }),
  // The contract between the client, the service, the proxy and the agents.
  restrictImports({
    files: ['src/protocol/**/*.ts'],
    ignores: ['**/*.spec.ts'],
    patterns: [
      { regex: '^\\.\\./', message: 'protocol/ is shared by every side: it imports none of them.' },
      { regex: PACKAGE, message: 'protocol/ has no dependency.' },
    ],
  }),
];
