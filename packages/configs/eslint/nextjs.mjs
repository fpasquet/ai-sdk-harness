// @ts-check
import nextPlugin from '@next/eslint-plugin-next';
import betterTailwindcss from 'eslint-plugin-better-tailwindcss';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

import baseConfig from './base.mjs';

/**
 * @param {string} dirname The directory of the calling `eslint.config.mjs`. The TypeScript
 *   parser resolves the app's tsconfig from it: run from the repository root (lint-staged), it
 *   would otherwise find several candidates and refuse to guess.
 * @param {{ tailwindEntryPoint?: string }} [options]
 */
export default (dirname, options = {}) =>
  tseslint.config(
    { ignores: ['.next/**', '.source/**', 'out/**', 'node_modules/**', 'next-env.d.ts'] },
    ...baseConfig,
    nextPlugin.configs.recommended,
    {
      plugins: {
        'react-hooks': reactHooks,
      },
      rules: {
        ...reactHooks.configs.recommended.rules,
      },
    },
    {
      ...betterTailwindcss.configs.recommended,
      settings: {
        'better-tailwindcss': {
          entryPoint: options.tailwindEntryPoint ?? './app/global.css',
        },
      },
    },
    {
      rules: {
        // Prettier owns line-wrapping decisions; this rule conflicts with it.
        'better-tailwindcss/enforce-consistent-line-wrapping': 'off',
      },
    },
    {
      // React components infer their return type (JSX.Element / ReactNode):
      // explicit annotations add noise without safety benefit here.
      // Components are also legitimately longer than back-end functions.
      rules: {
        '@typescript-eslint/explicit-module-boundary-types': 'off',
        'max-lines-per-function': 'off',
      },
    },
    {
      languageOptions: {
        globals: {
          ...globals.browser,
          ...globals.node,
        },
        parserOptions: {
          tsconfigRootDir: dirname,
        },
      },
    },
  );
