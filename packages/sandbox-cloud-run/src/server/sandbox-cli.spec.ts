import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { DirectorySnapshotStore } from './directory-snapshot-store.js';
import { SandboxCli } from './sandbox-cli.js';

describe('SandboxCli', () => {
  it('reports a CLI it cannot run, for a command and for a process', async () => {
    const cli = new SandboxCli('/nonexistent/sandbox');

    await expect(cli.create('box')).rejects.toThrow('ENOENT');
    expect(await cli.exec('box', ['true']).exited).toBe(127);
  });
});

describe('DirectorySnapshotStore', () => {
  it('reports a snapshot it cannot read, other than a missing one', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'snapshots-'));
    mkdirSync(join(directory, 'snapshots', 'box.tar.gz'), { recursive: true });
    const store = new DirectorySnapshotStore(directory);

    const opened = await store.open('snapshots/box.tar.gz');
    await expect(new Response(Readable.toWeb(opened!) as ReadableStream).text()).rejects.toThrow();
    rmSync(directory, { recursive: true, force: true });
  });
});
