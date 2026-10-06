import { readFileSync } from 'node:fs';

/** The version of this package, which the service reports and its templates are tied to. */
export const PACKAGE_VERSION = (
  JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;
