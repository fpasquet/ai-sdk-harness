// @ts-check
import nextPlugin from '@next/eslint-plugin-next';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

// shadcn/ui and AI Elements components are vendored from their registries
// (`shadcn add`): they keep the shape upstream gives them, so an update is a
// plain re-add rather than a merge.
const ignores = {
  ignores: [
    '.next/**',
    'node_modules/**',
    'next-env.d.ts',
    'components/ui/**',
    'components/ai-elements/**',
  ],
};

// In the monorepo, the repository's own rules; fetched on its own, those of Next.js and React.
const repository = await import('@repo/eslint-config/nextjs').catch(() => undefined);

export default repository
  ? [
      ignores,
      ...repository.default(import.meta.dirname, { tailwindEntryPoint: './app/globals.css' }),
    ]
  : tseslint.config(
      ignores,
      ...tseslint.configs.recommended,
      nextPlugin.configs.recommended,
      { plugins: { 'react-hooks': reactHooks }, rules: reactHooks.configs.recommended.rules },
      {
        rules: {
          // As the repository's rules: a name starting with `_` is unused on purpose.
          '@typescript-eslint/no-unused-vars': [
            'error',
            { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
          ],
        },
      },
    );
