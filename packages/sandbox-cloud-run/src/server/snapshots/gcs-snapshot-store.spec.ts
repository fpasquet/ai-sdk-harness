import type { AddressInfo } from 'node:net';

import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GcsSnapshotStore } from './gcs-snapshot-store.js';

/** A fake of Cloud Storage's JSON API and of the metadata server, on one port. */
function fakeGoogle() {
  const objects = new Map<string, Buffer>();
  const seen: { authorization?: string; path: string }[] = [];
  let tokens = 0;
  let failing = false;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://google');
    seen.push({ path: url.pathname, authorization: request.headers.authorization });
    if (url.pathname.startsWith('/computeMetadata/')) {
      tokens++;
      response.end(JSON.stringify({ access_token: `token-${tokens}`, expires_in: 3600 }));
      return;
    }
    if (failing) {
      response.writeHead(500).end('broken');
      return;
    }
    const name =
      url.searchParams.get('name') ?? decodeURIComponent(url.pathname.split('/o/')[1] ?? '');
    if (request.method === 'POST') {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        objects.set(name, Buffer.concat(chunks));
        response.end('{}');
      });
      return;
    }
    const object = objects.get(name);
    if (object === undefined) {
      response.writeHead(404).end();
      return;
    }
    if (request.method === 'DELETE') objects.delete(name);
    response.end(url.searchParams.get('alt') === 'media' ? object : '{}');
  });
  return {
    server,
    objects,
    seen,
    tokens: () => tokens,
    fail: () => {
      failing = true;
    },
  };
}

describe('GcsSnapshotStore', () => {
  let google: ReturnType<typeof fakeGoogle>;
  let store: GcsSnapshotStore;

  beforeEach(async () => {
    google = fakeGoogle();
    await new Promise<void>((resolve) => google.server.listen(0, '127.0.0.1', resolve));
    const endpoint = `http://127.0.0.1:${(google.server.address() as AddressInfo).port}`;
    store = new GcsSnapshotStore('bucket', { storage: endpoint, metadata: endpoint });
  });
  afterEach(async () => {
    await new Promise((resolve) => google.server.close(resolve));
  });

  it('saves a tar gzipped, opens, finds and removes it', async () => {
    await store.save('snapshots/box.tar.gz', Readable.from([Buffer.from('tar bytes')]));
    expect(
      gunzipSync(google.objects.get('snapshots/box.tar.gz') ?? Buffer.alloc(0)).toString(),
    ).toBe('tar bytes');
    expect(await store.exists('snapshots/box.tar.gz')).toBe(true);
    const opened = await store.open('snapshots/box.tar.gz');
    expect(await new Response(Readable.toWeb(opened!) as ReadableStream).text()).toBe('tar bytes');
    await store.remove('snapshots/box.tar.gz');

    expect(await store.exists('snapshots/box.tar.gz')).toBe(false);
    expect(await store.open('snapshots/box.tar.gz')).toBeUndefined();
    await store.remove('snapshots/box.tar.gz');
  });

  it('authenticates with one token of the service account, reused while it lasts', async () => {
    await store.exists('a');
    await store.exists('b');

    expect(google.tokens()).toBe(1);
    expect(
      google.seen.filter(({ path }) => path.startsWith('/storage/')).map((s) => s.authorization),
    ).toEqual(['Bearer token-1', 'Bearer token-1']);
  });

  it('reports a failure of Cloud Storage', async () => {
    google.fail();

    await expect(store.exists('a')).rejects.toThrow(
      'Could not look up a on Cloud Storage: 500 broken',
    );
  });
});
