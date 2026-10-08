import type { Readable } from 'node:stream';

import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';

import type { SnapshotStore } from './snapshot-store.js';

import { gunzip, gzip, piped } from './snapshot-store.js';

/**
 * Snapshots as files of a directory: for the service off Cloud Run. On Cloud Run the disk is the
 * instance's memory and goes with it: the snapshots belong in a bucket (`GcsSnapshotStore`).
 */
export class DirectorySnapshotStore implements SnapshotStore {
  constructor(private readonly directory: string) {}

  async save(key: string, source: Readable): Promise<void> {
    const target = this.path(key);
    // Written aside, then moved in place: a failed save leaves the previous tar whole.
    const partial = `${target}.${randomUUID()}.partial`;
    await mkdir(dirname(target), { recursive: true });
    try {
      await pipeline(source, gzip(), createWriteStream(partial));
      await rename(partial, target);
    } finally {
      await rm(partial, { force: true });
    }
  }

  async open(key: string): Promise<Readable | undefined> {
    if (!(await this.exists(key))) return undefined;
    return piped(createReadStream(this.path(key)), gunzip());
  }

  async exists(key: string): Promise<boolean> {
    return access(this.path(key)).then(
      () => true,
      () => false,
    );
  }

  async remove(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }

  private path(key: string): string {
    return join(this.directory, key);
  }
}
