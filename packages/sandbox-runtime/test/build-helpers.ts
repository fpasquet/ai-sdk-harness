import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/** Where the suite builds the package: aside from `dist`, which a running app may be using. */
export const TEST_BUILD = fileURLToPath(
  new URL('../node_modules/.cache/test-build/', import.meta.url),
);

/**
 * Builds the package before the suite: the sandboxes run the supervisor of `src/in-sandbox/` as
 * a process of its own, built. Never into `dist`, which `pnpm build` alone writes: rebuilding it
 * empties it first, under the feet of an app that imports the package meanwhile.
 */
export default function setup(): void {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
  const build = spawnSync(
    process.execPath,
    [
      tsc,
      '-p',
      'tsconfig.build.json',
      '--outDir',
      TEST_BUILD,
      '--declaration',
      'false',
      '--incremental',
      'false',
    ],
    { cwd: root, stdio: 'inherit' },
  );
  if (build.status !== 0) throw new Error('The package did not build.');
}
