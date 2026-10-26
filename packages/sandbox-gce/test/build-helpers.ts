import { spawnSync } from 'node:child_process';
import { copyFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/**
 * Where the suite builds the package: aside from `dist`, which a running app may be using, with
 * its `package.json` one level up, where the built code reads its version.
 */
export const TEST_BUILD = fileURLToPath(
  new URL('../node_modules/.cache/test-build/dist/', import.meta.url),
);

/**
 * Builds the package before the suite: the fake Compute Engine boots each machine as an agent
 * process of its own, built. Never into `dist`, which `pnpm build` alone writes: rebuilding it
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
  copyFileSync(`${root}/package.json`, `${TEST_BUILD}../package.json`);
}
