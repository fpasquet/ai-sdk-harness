// @ts-check
import nextjsConfig from '@repo/eslint-config/nextjs';

export default [
  // shadcn/ui and AI Elements components are vendored from their registries
  // (`shadcn add`): they keep the shape upstream gives them, so an update is a
  // plain re-add rather than a merge.
  { ignores: ['components/ui/**', 'components/ai-elements/**'] },
  ...nextjsConfig(import.meta.dirname, { tailwindEntryPoint: './app/globals.css' }),
];
