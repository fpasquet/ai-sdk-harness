import type { Readable } from 'node:stream';

import { createGunzip, createGzip } from 'node:zlib';

/**
 * Where the tars of the sandboxes' writable layers are kept, gzipped, under a key:
 * `snapshots/<sandbox>` for a suspended sandbox, `templates/<namespace>/<id>` for a template. What
 * lets the instance stop between two turns: a sandbox lives in the memory of the instance that
 * started it, a snapshot outlives the instance. Tars come and go as streams: the instance's disk is
 * its memory, and a layer can weigh hundreds of megabytes.
 */
export interface SnapshotStore {
  /** Keeps the tar `source` streams under `key`, replacing what was there. */
  save(key: string, source: Readable): Promise<void>;
  /** The tar kept under `key`, as a stream: `undefined` when there is none. */
  open(key: string): Promise<Readable | undefined>;
  /** Whether a tar is kept under `key`. */
  exists(key: string): Promise<boolean>;
  /** Forgets the tar under `key`, if any. */
  remove(key: string): Promise<void>;
}

/** The key of a suspended sandbox's snapshot. */
export const snapshotKey = (sandbox: string): string => `snapshots/${sandbox}.tar.gz`;

/**
 * The key of a template. `namespace` stands for the image the template was made on: a template is
 * a layer over the image, and means nothing over another one.
 */
export const templateKey = (namespace: string, id: string): string =>
  `templates/${namespace}/${id}.tar.gz`;

/** Fast compression: a snapshot is written on every suspension, and read on every resume. */
export const gzip = (): ReturnType<typeof createGzip> => createGzip({ level: 1 });

export const gunzip = (): ReturnType<typeof createGunzip> => createGunzip();

/** `source` piped into `transform`, an error of `source` ending `transform` too. */
export function piped<T extends NodeJS.ReadWriteStream & Readable>(
  source: Readable,
  transform: T,
): T {
  source.once('error', (error) => transform.destroy(error));
  return source.pipe(transform);
}
