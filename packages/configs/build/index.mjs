#!/usr/bin/env node
// Shared build for publishable packages: clean dist, then compile with tsc
// against the package's own tsconfig.build.json.
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const cwd = process.cwd();

rmSync(join(cwd, 'dist'), { recursive: true, force: true });

const tscBin = createRequire(join(cwd, 'package.json')).resolve('typescript/bin/tsc');
const tsc = spawnSync(process.execPath, [tscBin, '-p', 'tsconfig.build.json'], {
  stdio: 'inherit',
});
if (tsc.status !== 0) process.exit(tsc.status ?? 1);
