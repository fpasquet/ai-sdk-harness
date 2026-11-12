import { readFileSync } from 'node:fs';

/** The version of this package, which every side reports and the templates are tied to. */
export const PACKAGE_VERSION = (
  JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;
