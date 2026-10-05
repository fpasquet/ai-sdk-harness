import type { ViteUserConfig } from 'vitest/config';

/** The shared Vitest preset, with a package's own settings merged on top. */
export function vitestConfig(overrides?: ViteUserConfig): ViteUserConfig;
