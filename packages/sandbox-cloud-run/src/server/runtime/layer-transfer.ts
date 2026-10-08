import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

import type { Logger } from '../logger.js';
import type { SnapshotStore } from '../snapshots/snapshot-store.js';

import { SandboxCliError } from './sandbox-cli-error.js';

/**
 * How a writable layer travels between the `sandbox` CLI, which reads and writes tars by path, and
 * the snapshot store, which streams. Through a named pipe, the tar is never held whole in the
 * instance's memory, which is its disk: a sandbox started from a template of hundreds of megabytes
 * would otherwise need room for it twice, and a suspension would wait for the whole tar before
 * uploading any of it. Through a file, when the CLI turns out not to take a pipe.
 */
export type LayerTransfer = 'fifo' | 'file';

const run = promisify(execFile);

/**
 * When the CLI failed before it opened its end of `fifo`, the stream on the other end waits for it
 * forever: this opens that end in its place and closes it at once, so the stream ends. A stream
 * whose end did open has its peer already, and ends with it: opening the pipe again would wait for
 * a peer that never comes.
 */
async function release(fifo: string, flags: 'r' | 'w', stream: NodeJS.EventEmitter): Promise<void> {
  if (opened.has(stream)) return;
  const handle = await open(fifo, flags).catch(() => undefined);
  await handle?.close();
}

/** The streams whose end of their pipe is open. */
const opened = new WeakSet<NodeJS.EventEmitter>();

function tracked<T extends NodeJS.EventEmitter>(stream: T): T {
  stream.once('open', () => opened.add(stream));
  return stream;
}

/** Both settled, then the CLI's failure thrown first, the stream's otherwise. */
async function settle(cli: Promise<void>, stream: Promise<void>): Promise<void> {
  const [cliResult, streamResult] = await Promise.allSettled([cli, stream]);
  if (cliResult.status === 'rejected') throw cliResult.reason;
  if (streamResult.status === 'rejected') throw streamResult.reason;
}

/** Moves layers between the CLI and `store`, through `scratch`: a pipe first, a file if need be. */
export class LayerTransfers {
  private mode: LayerTransfer;

  constructor(
    private readonly options: { logger: Logger; scratch: string; store: SnapshotStore },
    mode: LayerTransfer = 'fifo',
  ) {
    this.mode = mode;
  }

  /** Saves under `key` the layer `write` writes, as a tar, to the path it is given. */
  async save(key: string, write: (path: string) => Promise<void>): Promise<void> {
    await this.withFallback(async (mode, path) => {
      if (mode === 'file') {
        await write(path);
        await this.options.store.save(key, createReadStream(path));
        return;
      }
      const reader = tracked(createReadStream(path));
      const writing = write(path).catch(async (error: unknown) => {
        await release(path, 'w', reader);
        throw error;
      });
      try {
        await settle(writing, this.options.store.save(key, reader));
      } catch (error) {
        // Whatever made it to the store before the failure is no layer.
        await this.options.store.remove(key).catch(() => undefined);
        throw error;
      }
    });
  }

  /**
   * Hands `read` the path of the tar kept under `key`, for as long as it reads it: `false` when no
   * tar is kept there.
   */
  async restore(key: string, read: (path: string) => Promise<void>): Promise<boolean> {
    let found = true;
    await this.withFallback(async (mode, path) => {
      const source = await this.options.store.open(key);
      if (source === undefined) {
        found = false;
        return;
      }
      if (mode === 'file') {
        await pipeline(source, createWriteStream(path));
        await read(path);
        return;
      }
      const writer = tracked(createWriteStream(path));
      const reading = read(path).catch(async (error: unknown) => {
        await release(path, 'r', writer);
        throw error;
      });
      await settle(reading, pipeline(source, writer));
    });
    return found;
  }

  /** Runs `transfer` through a pipe, then through a file for good if the pipe failed. */
  private async withFallback(
    transfer: (mode: LayerTransfer, path: string) => Promise<void>,
  ): Promise<void> {
    if (this.mode === 'fifo') {
      try {
        await this.through('fifo', transfer);
        return;
      } catch (error) {
        // Only the CLI may refuse a pipe: a failure of the store is the store's, a file or not.
        if (!(error instanceof SandboxCliError)) throw error;
        const reason = error.message;
        this.options.logger.error(
          `A layer could not go through a pipe, files from now on: ${reason}`,
        );
        this.mode = 'file';
      }
    }
    await this.through('file', transfer);
  }

  private async through(
    mode: LayerTransfer,
    transfer: (mode: LayerTransfer, path: string) => Promise<void>,
  ): Promise<void> {
    const path = join(this.options.scratch, `layer-${randomUUID()}.tar`);
    try {
      if (mode === 'fifo') await run('mkfifo', ['-m', '600', path]);
      await transfer(mode, path);
    } finally {
      await rm(path, { force: true });
    }
  }
}
