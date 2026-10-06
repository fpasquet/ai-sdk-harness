import type { ReadableStream as NodeReadableStream } from 'node:stream/web';

import { Readable } from 'node:stream';

import type { SnapshotStore } from './snapshot-store.js';

import { gunzip, gzip, piped } from './snapshot-store.js';

/** Where the Google APIs are reached: overridden in tests. */
export interface GoogleEndpoints {
  /** Cloud Storage's JSON API. */
  storage: string;
  /** The metadata server, which hands the instance's service account its tokens. */
  metadata: string;
}

const GOOGLE: GoogleEndpoints = {
  storage: 'https://storage.googleapis.com',
  metadata: 'http://metadata.google.internal',
};

/**
 * Snapshots as objects of a Cloud Storage bucket, through its JSON API, with a token of the
 * instance's service account: it needs `roles/storage.objectUser` on the bucket, and nothing
 * else. The sandboxes never reach the metadata server: only the service holds the token. A bucket
 * in the service's region costs no transfer. Tars are streamed both ways: none is ever held whole
 * in the instance's memory.
 */
export class GcsSnapshotStore implements SnapshotStore {
  private token?: { expiresAt: number; value: string };

  constructor(
    private readonly bucket: string,
    private readonly endpoints: GoogleEndpoints = GOOGLE,
  ) {}

  async save(key: string, source: Readable): Promise<void> {
    const url = new URL(`/upload/storage/v1/b/${this.bucket}/o`, this.endpoints.storage);
    url.searchParams.set('uploadType', 'media');
    url.searchParams.set('name', key);
    const body = Readable.toWeb(piped(source, gzip())) as ReadableStream<Uint8Array>;
    const response = await fetch(url, {
      method: 'POST',
      headers: { ...(await this.authorization()), 'content-type': 'application/gzip' },
      body,
      duplex: 'half',
    } as RequestInit);
    await check(response, `save ${key}`);
  }

  async open(key: string): Promise<Readable | undefined> {
    const response = await fetch(`${this.objectUrl(key)}?alt=media`, {
      headers: await this.authorization(),
    });
    if (response.status === 404) return undefined;
    await check(response, `restore ${key}`);
    return piped(Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>), gunzip());
  }

  async exists(key: string): Promise<boolean> {
    const response = await fetch(this.objectUrl(key), { headers: await this.authorization() });
    if (response.status === 404) return false;
    await check(response, `look up ${key}`);
    return true;
  }

  async remove(key: string): Promise<void> {
    const response = await fetch(this.objectUrl(key), {
      method: 'DELETE',
      headers: await this.authorization(),
    });
    if (response.status !== 404) await check(response, `remove ${key}`);
  }

  private objectUrl(key: string): string {
    return new URL(
      `/storage/v1/b/${this.bucket}/o/${encodeURIComponent(key)}`,
      this.endpoints.storage,
    ).toString();
  }

  /** A token of the instance's service account, fetched again a minute before it expires. */
  private async authorization(): Promise<Record<string, string>> {
    if (this.token === undefined || Date.now() > this.token.expiresAt) {
      const response = await fetch(
        new URL(
          '/computeMetadata/v1/instance/service-accounts/default/token',
          this.endpoints.metadata,
        ),
        { headers: { 'metadata-flavor': 'Google' } },
      );
      await check(response, 'get a token from the metadata server');
      const { access_token: value, expires_in: seconds } = (await response.json()) as {
        access_token: string;
        expires_in: number;
      };
      this.token = { value, expiresAt: Date.now() + (seconds - 60) * 1000 };
    }
    return { authorization: `Bearer ${this.token.value}` };
  }
}

async function check(response: Response, what: string): Promise<void> {
  if (!response.ok) {
    throw new Error(
      `Could not ${what} on Cloud Storage: ${response.status} ${await response.text()}`,
    );
  }
}
