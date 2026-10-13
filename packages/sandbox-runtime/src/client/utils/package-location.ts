import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/** Package names, put together at run time: a bundler leaves a specifier it cannot read alone. */
const SELF = ['ai-sdk-sandbox-runtime', 'package.json'].join('/');
const SRT = ['@anthropic-ai', 'sandbox-runtime', 'package.json'].join('/');

/** `specifier` resolved from `base`, or `undefined` when it cannot be from there. */
function resolveFrom(base: string, specifier: string): string | undefined {
  try {
    return createRequire(base).resolve(specifier);
  } catch {
    return undefined;
  }
}

/**
 * Where this package is installed, found by its name: from this module, or from the application
 * when a bundler moved the module, as Next.js does with a workspace dependency, rewriting its
 * `import.meta.url` and the specifiers it can read.
 */
export function packageRoot(cwd: string = process.cwd()): string {
  const found = resolveFrom(import.meta.url, SELF) ?? resolveFrom(join(cwd, 'package.json'), SELF);
  if (found === undefined)
    throw new Error('ai-sdk-sandbox-runtime cannot find where it is installed.');
  return dirname(found);
}

/** Where srt's package is installed: the one this package depends on. */
export function srtRoot(): string {
  const found = resolveFrom(join(packageRoot(), 'package.json'), SRT);
  if (found === undefined) throw new Error('ai-sdk-sandbox-runtime cannot find srt.');
  return dirname(found);
}
