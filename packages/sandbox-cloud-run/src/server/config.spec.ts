import { describe, expect, it } from 'vitest';

import { listenConfig, sandboxesConfig } from './config.js';
import { DirectorySnapshotStore } from './directory-snapshot-store.js';
import { GcsSnapshotStore } from './gcs-snapshot-store.js';
import { silentLogger } from './logger.js';

describe('the service configuration', () => {
  it('listens on the loopback off Cloud Run, on every interface on it', () => {
    expect(listenConfig({})).toEqual({ port: 8080, host: '127.0.0.1', jsonLogs: false });
    expect(listenConfig({ K_SERVICE: 'sandboxes', PORT: '9000' })).toEqual({
      port: 9000,
      host: '0.0.0.0',
      jsonLogs: true,
    });
    expect(listenConfig({ HOST: '::1', LOG_FORMAT: 'json' })).toMatchObject({
      host: '::1',
      jsonLogs: true,
    });
  });

  it('defaults to Cloud Run paths, the model APIs and a local snapshot directory', () => {
    const config = sandboxesConfig({}, silentLogger);

    expect(config.sandbox).toMatchObject({
      home: '/home/agent',
      workingDirectory: '/workspace',
      egressPort: 3128,
      node: process.execPath,
    });
    expect(config.sandbox.helpers).toMatch(/in-sandbox\/$/);
    expect(config.network).toEqual({
      allowedHosts: [],
      baseUrls: {
        ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
        OPENAI_BASE_URL: 'https://api.openai.com/v1',
      },
    });
    expect(config.store).toBeInstanceOf(DirectorySnapshotStore);
  });

  it('reads the hosts, base URLs and bucket from the environment', () => {
    const config = sandboxesConfig(
      {
        SANDBOX_ALLOWED_HOSTS: 'registry.npmjs.org, *.pypi.org,',
        SANDBOX_BASE_URLS: 'ANTHROPIC_BASE_URL=https://gateway.example.com/anthropic',
        SNAPSHOT_BUCKET: 'snapshots',
      },
      silentLogger,
    );

    expect(config.network).toEqual({
      allowedHosts: ['registry.npmjs.org', '*.pypi.org'],
      baseUrls: { ANTHROPIC_BASE_URL: 'https://gateway.example.com/anthropic' },
    });
    expect(config.store).toBeInstanceOf(GcsSnapshotStore);
  });

  it('ties the templates to this package, its Node.js and the image', () => {
    const namespace = (env: Record<string, string>): string =>
      sandboxesConfig(env, silentLogger).templateNamespace;

    expect(namespace({})).toMatch(/^[0-9a-f]{16}$/);
    expect(namespace({ K_REVISION: 'a' })).not.toBe(namespace({ K_REVISION: 'b' }));
    expect(namespace({ K_REVISION: 'a', SANDBOX_IMAGE_ID: 'x' })).toBe(
      namespace({ K_REVISION: 'b', SANDBOX_IMAGE_ID: 'x' }),
    );
  });

  it('reads how layers travel, the service token and private networks off Cloud Run', () => {
    const config = sandboxesConfig(
      {
        SNAPSHOT_TRANSFER: 'file',
        SANDBOX_SERVICE_TOKEN: 'secret',
        SANDBOX_ALLOW_PRIVATE_NETWORK: 'true',
      },
      silentLogger,
    );

    expect(config).toMatchObject({ layerTransfer: 'file', serviceToken: 'secret' });
    expect(config.sandbox.allowPrivateNetwork).toBe(true);
    expect(sandboxesConfig({ SANDBOX_SERVICE_TOKEN: '' }, silentLogger)).toMatchObject({
      layerTransfer: 'fifo',
      serviceToken: undefined,
    });
  });

  it('refuses private networks on Cloud Run', () => {
    expect(() =>
      sandboxesConfig(
        { K_SERVICE: 'sandboxes', SNAPSHOT_BUCKET: 'b', SANDBOX_ALLOW_PRIVATE_NETWORK: 'true' },
        silentLogger,
      ),
    ).toThrow('refused on Cloud Run');
  });

  it('refuses a malformed base URL, and Cloud Run without a bucket', () => {
    expect(() => sandboxesConfig({ SANDBOX_BASE_URLS: 'nonsense' }, silentLogger)).toThrow(
      'is not NAME=url',
    );
    expect(() => sandboxesConfig({ K_SERVICE: 'sandboxes' }, silentLogger)).toThrow(
      'SNAPSHOT_BUCKET is required',
    );
  });
});
