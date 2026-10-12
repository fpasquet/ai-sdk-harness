import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');
const MARKETPLACE = join(ROOT, '../../examples/next-chat/marketplace');

/** The JSON blocks of the README, parsed. */
const blocks = [
  ...readFileSync(join(ROOT, 'README.md'), 'utf8').matchAll(/```json\n([\s\S]*?)```/g),
]
  .map(([, json]) => JSON.parse(json ?? '') as unknown)
  .filter((block): block is { kind?: string; name: string } => typeof block === 'object');

const stored = (directory: string) =>
  readdirSync(join(MARKETPLACE, directory)).map((file) => ({
    file: `${directory}/${file}`,
    json: JSON.parse(readFileSync(join(MARKETPLACE, directory, file), 'utf8')) as {
      kind?: string;
      name: string;
    },
  }));

describe('the README', () => {
  // Its screenshots come from the Next.js example: the JSON beside them must be the example's.
  it.each([...stored('plugins'), ...stored('items')])(
    'shows $file as the example keeps it',
    ({ json }) => {
      const shown = blocks.find(({ kind, name }) => kind === json.kind && name === json.name);
      expect(shown).toEqual(json);
    },
  );
});
