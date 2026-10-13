import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ALLOWED_DOMAINS } from '../srt-settings.js';
import {
  createSandboxDirectory,
  defaultDirectory,
  layoutOf,
  readSandboxRecord,
  recordOf,
} from './sandbox-directory.js';

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ai-sdk-srt-dir-'));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('the directory of a sandbox', () => {
  it('keeps what the sandbox may write apart from its settings', () => {
    expect(layoutOf(directory, 'box')).toEqual({
      base: join(directory, 'box'),
      record: join(directory, 'box', 'sandbox.json'),
      writable: join(directory, 'box', 'sandbox'),
      home: join(directory, 'box', 'sandbox', 'home'),
      tmpdir: join(directory, 'box', 'sandbox', 'tmp'),
      workspace: join(directory, 'box', 'sandbox', 'workspace'),
    });
    expect(defaultDirectory()).toMatch(/\.ai-sdk-sandbox-runtime$/);
  });

  it('refuses an id that is not a plain name', () => {
    expect(() => layoutOf(directory, '../escape')).toThrow('Not a sandbox id');
    expect(() => layoutOf(directory, '')).toThrow('Not a sandbox id');
  });

  it('records the settings of a sandbox, its paths made absolute', () => {
    expect(recordOf({})).toEqual({
      version: 1,
      readOnlyWorkspaces: [],
      allowedDomains: [...DEFAULT_ALLOWED_DOMAINS],
      hideHome: true,
      denyRead: [],
      allowRead: [],
      allowWrite: [],
      denyWrite: [],
    });
    expect(
      recordOf({ workspace: 'project', denyRead: ['secret'], allowedDomains: [] }),
    ).toMatchObject({
      workspace: resolve('project'),
      denyRead: [resolve('secret')],
      allowedDomains: [],
    });
  });

  it('is created once, and read back', async () => {
    const layout = layoutOf(directory, 'box');
    const record = recordOf({ workspace: directory });

    await createSandboxDirectory(layout, record);

    expect(await readSandboxRecord(layout)).toEqual(record);
    expect(JSON.parse(await readFile(layout.record, 'utf8'))).toEqual(record);
    await expect(createSandboxDirectory(layout, record)).rejects.toThrow('already exists');
    expect(await readSandboxRecord(layoutOf(directory, 'other'))).toBeUndefined();
  });

  it('refuses a workspace that is not a directory, and a record it does not know', async () => {
    await expect(
      createSandboxDirectory(
        layoutOf(directory, 'box'),
        recordOf({ workspace: join(directory, 'none') }),
      ),
    ).rejects.toThrow('is not a directory');

    const layout = layoutOf(directory, 'future');
    await mkdir(layout.base, { recursive: true });
    await writeFile(layout.record, JSON.stringify({ version: 2 }));
    await expect(readSandboxRecord(layout)).rejects.toThrow('Unknown sandbox record');
  });
});
