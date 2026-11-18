// @ts-check
import { notFrom, restrictImports } from '@repo/eslint-config/boundaries';
import nodeConfig from '@repo/eslint-config/node';

/** Runs in the browser as well, where a form shows the requests: nothing of Node.js. */
const ISOMORPHIC = {
  regex: '^node:',
  message: 'The package runs in the browser too: no node: imports.',
};

/** What `ai-sdk-harness-approval/describe` reads is installed without the peer dependencies. */
const NO_PEERS = {
  regex: '^(?:ai|@ai-sdk/.*)$',
  message:
    'ai-sdk-harness-approval/describe needs no peer dependency: nothing of ai nor @ai-sdk/*, not even a type.',
};

/**
 * The layers of the package, each importing only the ones below it: `definitions/` (types and
 * constants) is a leaf, then `utils/` (shell and path parsing) ← `policy/`; `describe/` and
 * `questions/` stand beside `policy/`. `definitions/`, `utils/` and `describe/` import nothing of
 * the peer dependencies: `ai-sdk-harness-approval/describe` exports them. `sandbox/`, on top,
 * runs in Node.js only: what installs the policies in a sandbox, and the hook that runs there;
 * `ai-sdk-harness-approval/sandbox` exports it.
 */
export default [
  ...nodeConfig(import.meta.dirname),
  restrictImports({
    files: ['src/definitions/**/*.ts'],
    patterns: [
      { regex: '^\\.\\./', message: 'definitions/ is a leaf: it imports nothing of the package.' },
      ISOMORPHIC,
      NO_PEERS,
    ],
  }),
  restrictImports({
    files: ['src/utils/**/*.ts'],
    patterns: [
      notFrom(
        ['policy', 'describe', 'questions', 'sandbox'],
        'utils/ may only import definitions/.',
      ),
      ISOMORPHIC,
      NO_PEERS,
    ],
  }),
  restrictImports({
    files: ['src/policy/**/*.ts'],
    patterns: [
      notFrom(
        ['describe', 'questions', 'sandbox'],
        'policy/ may not import describe/, questions/ or sandbox/.',
      ),
      ISOMORPHIC,
    ],
  }),
  restrictImports({
    files: ['src/describe/**/*.ts'],
    patterns: [
      notFrom(
        ['policy', 'questions', 'sandbox'],
        'describe/ reads a call, beside questions/: it may not import policy/, questions/ or sandbox/.',
      ),
      ISOMORPHIC,
      NO_PEERS,
    ],
  }),
  restrictImports({
    files: ['src/questions/**/*.ts'],
    patterns: [
      notFrom(
        ['describe', 'questions', 'sandbox'],
        'describe/ and questions/ stand beside each other, below sandbox/.',
      ),
      ISOMORPHIC,
    ],
  }),
  restrictImports({
    files: ['src/*.ts'],
    ignores: ['src/sandbox.ts', 'src/describe.ts'],
    patterns: [
      ISOMORPHIC,
      notFrom(['sandbox'], 'The main entry runs in the browser: sandbox/ is Node.js only.'),
    ],
  }),
  restrictImports({
    files: ['src/describe.ts'],
    patterns: [
      ISOMORPHIC,
      NO_PEERS,
      notFrom(
        ['policy', 'questions', 'sandbox'],
        'ai-sdk-harness-approval/describe reads a call: nothing of policy/, questions/ nor sandbox/.',
      ),
    ],
  }),
];
