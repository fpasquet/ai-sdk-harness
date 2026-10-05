// @ts-check
import checkFile from 'eslint-plugin-check-file';
import globals from 'globals';
import tseslint from 'typescript-eslint';

import baseConfig from './base.mjs';

/**
 * Type-aware preset for the ESM Node.js packages and scripts. Builds on the
 * framework-agnostic base and adds the rules that need type information.
 *
 * @param {string} dirname The directory of the calling `eslint.config.mjs`.
 */
export default (dirname) =>
  tseslint.config(
    { ignores: ['dist/**', 'coverage/**', 'eslint.config.mjs', 'vitest.config.ts'] },
    ...baseConfig,
    ...tseslint.configs.recommendedTypeChecked,
    {
      languageOptions: {
        globals: {
          ...globals.node,
        },
        sourceType: 'module',
        parserOptions: {
          projectService: true,
          tsconfigRootDir: dirname,
        },
      },
      // Type-aware rules, which require projectService: true
      rules: {
        '@typescript-eslint/no-floating-promises': 'error',
        '@typescript-eslint/no-unsafe-argument': 'error',
        '@typescript-eslint/no-unsafe-assignment': 'error',
        '@typescript-eslint/require-await': 'error',
        '@typescript-eslint/prefer-nullish-coalescing': 'error',
        '@typescript-eslint/prefer-optional-chain': 'error',
        '@typescript-eslint/consistent-type-imports': 'error',
        // Re-declared here to override recommendedTypeChecked's stricter default
        // which lacks the ignore patterns defined in base.mjs.
        '@typescript-eslint/no-unused-vars': [
          'error',
          {
            argsIgnorePattern: '^_',
            varsIgnorePattern: '^_',
            caughtErrorsIgnorePattern: '^_',
          },
        ],
      },
    },
    {
      plugins: {
        'check-file': checkFile,
      },
      rules: {
        // Every TypeScript file and source directory is kebab-case; middle
        // extensions (.spec, .e2e-spec, .d …) are ignored.
        'check-file/filename-naming-convention': [
          'error',
          { '**/*.ts': 'KEBAB_CASE' },
          { ignoreMiddleExtensions: true },
        ],
        'check-file/folder-naming-convention': ['error', { 'src/**': 'KEBAB_CASE' }],
      },
    },
    {
      // Plain JavaScript files (config files, test fixtures) are outside every tsconfig.
      files: ['**/*.{js,mjs,cjs}'],
      ...tseslint.configs.disableTypeChecked,
    },
    {
      // Scripts are command-line tools: printing is what they do, and the
      // variables they read come from the CI run, not from a build turbo hashes.
      files: ['scripts/**/*.ts'],
      rules: {
        'no-console': 'off',
        'turbo/no-undeclared-env-vars': 'off',
        complexity: 'off',
      },
    },
    {
      // Spec files: test helpers and fixtures legitimately take many arguments
      // and nest callbacks deeper than production code. The variables they read
      // configure a test run, never a build, so turbo has nothing to hash.
      files: ['**/*.spec.ts', '**/*.e2e-spec.ts', 'test/**/*'],
      rules: {
        'turbo/no-undeclared-env-vars': 'off',
        'max-nested-callbacks': 'off',
        'max-params': 'off',
        '@typescript-eslint/no-non-null-assertion': 'off',
      },
    },
  );
