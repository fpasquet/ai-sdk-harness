// @ts-check

/**
 * Import boundaries between the folders of a package, enforced with `no-restricted-imports`.
 *
 * ESLint does not merge a rule's options across config objects: the last one matching a file
 * wins. Each folder therefore gets a single entry carrying every pattern that applies to it.
 */

/** @typedef {{ regex: string, message: string }} Pattern */
/** @typedef {{ name: string, message: string, allowTypeImports?: boolean }} RestrictedPath */

/**
 * A `no-restricted-imports` entry for the files matching `files`.
 *
 * @param {{ files: string[], ignores?: string[], patterns?: Pattern[], paths?: RestrictedPath[] }} boundary
 */
export const restrictImports = ({ files, ignores = [], patterns = [], paths = [] }) => ({
  files,
  ignores,
  rules: { 'no-restricted-imports': ['error', { paths, patterns }] },
});

/**
 * Forbids relative imports of the sibling folders `folders`, whatever their depth.
 *
 * @param {string[]} folders
 * @param {string} message
 * @returns {Pattern}
 */
export const notFrom = (folders, message) => ({
  regex: `^\\.{1,2}/(?:.*/)?(?:${folders.join('|')})/`,
  message,
});

/**
 * The layers of a sandbox client (the whole `src/` of `ai-sdk-sandbox-sbx` and
 * `ai-sdk-sandbox-microsandbox`, `src/client/` of `ai-sdk-sandbox-cloud-run`): `errors/` and
 * `utils/` import nothing of the package, then each layer only imports the ones below it:
 * `transport/` ← `network/` ← `session/` ← `lifecycle/`.
 *
 * @param {string} root The client's directory, relative to the package (`src`, `src/client`).
 * @param {Pattern[]} [extra] Patterns every file of the client is held to besides.
 * @param {{ sdk?: string }} [options] `sdk`: the package through which the client reaches its
 *   sandboxes, which only `transport/` may import at runtime; the other layers import its types.
 */
export function sandboxClientLayers(root, extra = [], { sdk } = {}) {
  /** @type {RestrictedPath[]} */
  const paths =
    sdk === undefined
      ? []
      : [
          {
            name: sdk,
            allowTypeImports: true,
            message: `Only transport/ reaches the sandbox: elsewhere, import the types of ${sdk} only.`,
          },
        ];
  const above = (/** @type {string} */ layer, /** @type {string[]} */ folders) =>
    restrictImports({
      files: [`${root}/${layer}/**/*.ts`],
      patterns: [
        notFrom(
          folders,
          `${layer}/ may not import ${folders.map((f) => `${f}/`).join(', ')}: they sit above it.`,
        ),
        ...extra,
      ],
      paths: layer === 'transport' ? [] : paths,
    });
  return [
    restrictImports({ files: [`${root}/*.ts`], patterns: extra, paths }),
    restrictImports({
      files: [`${root}/errors/**/*.ts`, `${root}/utils/**/*.ts`],
      patterns: [
        {
          regex: '^\\.\\./',
          message: 'errors/ and utils/ are leaves: they import nothing of the package.',
        },
        ...extra,
      ],
      paths,
    }),
    above('transport', ['network', 'session', 'lifecycle']),
    above('network', ['session', 'lifecycle']),
    above('session', ['lifecycle']),
    restrictImports({ files: [`${root}/lifecycle/**/*.ts`], patterns: extra, paths }),
  ];
}
