/**
 * Pins each package's README to the version in its package.json: run by `pnpm version-packages`
 * after `changeset version`, so the release pull request carries the README of the version it
 * publishes, and by the CI with `--check`, which fails when a README names another version.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SEMVER = String.raw`\d+\.\d+\.\d+`;

/** What else names a package's version in its README, without the package's name. */
const UNNAMED: Readonly<Record<string, readonly RegExp[]>> = {
  // The proxy's startup script.
  'ai-sdk-sandbox-gce': [new RegExp(`^(VERSION=)${SEMVER}$`, 'gm')],
  // The published image the templates are tied to.
  'ai-sdk-sandbox-cloud-run': [new RegExp(`(SANDBOX_IMAGE_ID=)${SEMVER}`, 'g')],
};

const escape = (text: string): string => text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

/** `readme` with every version of `name` replaced by `version`: an npm install, an image tag. */
function pinned(readme: string, name: string, version: string): string {
  const named = new RegExp(`((?<![\\w-])${escape(name)}[@:])${SEMVER}(?![\\w-]|\\.\\d)`, 'g');
  return [named, ...(UNNAMED[name] ?? [])].reduce(
    (text, pattern) => text.replace(pattern, `$1${version}`),
    readme,
  );
}

function main(check: boolean): void {
  // Run from the repository's root, as `pnpm readme-versions` does.
  const packages = join(process.cwd(), 'packages');
  const stale: string[] = [];
  for (const entry of readdirSync(packages, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = join(packages, entry.name);
    // `packages/configs` holds the presets, a folder of packages of its own, never published.
    if (!existsSync(join(directory, 'package.json'))) continue;
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as {
      name: string;
      private?: boolean;
      version: string;
    };
    if (manifest.private === true) continue;
    const path = join(directory, 'README.md');
    const readme = readFileSync(path, 'utf8');
    const updated = pinned(readme, manifest.name, manifest.version);
    if (updated === readme) continue;
    stale.push(`packages/${entry.name}/README.md`);
    if (!check) writeFileSync(path, updated);
  }
  if (check && stale.length > 0) {
    process.stderr.write(
      `These READMEs name another version than their package.json, run \`pnpm readme-versions\`:\n${stale.map((path) => `  ${path}\n`).join('')}`,
    );
    process.exitCode = 1;
  }
}

main(process.argv.includes('--check'));
