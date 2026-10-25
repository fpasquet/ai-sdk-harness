import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { silentLogger } from '../common/logger.js';
import { listenConfig, sandboxesConfig } from './config.js';
import { KubernetesCredentials } from './kubernetes/credentials.js';

const REQUIRED = {
  SANDBOX_NAMESPACE: 'sandboxes',
  SANDBOX_IMAGE: 'europe-docker.pkg.dev/p/sandboxes/default@sha256:0123',
  SANDBOX_AGENT_SECRET: 'x'.repeat(32),
  SANDBOX_SERVICE_TOKEN: 'y'.repeat(32),
  SANDBOX_PROXY_URL: 'http://10.8.0.12:3128',
  SANDBOX_PROXY_ADMIN_URL: 'http://ai-sdk-sandbox-proxy:3129',
  SANDBOX_PROXY_TOKEN: 'proxy-token',
};

describe('the service configuration', () => {
  it('listens on every interface in a cluster, on the loopback elsewhere', () => {
    expect(listenConfig({ KUBERNETES_SERVICE_HOST: '10.0.0.1', PORT: '9000' })).toEqual({
      port: 9000,
      host: '0.0.0.0',
      jsonLogs: true,
    });
    expect(listenConfig({})).toEqual({ port: 8080, host: '127.0.0.1', jsonLogs: false });
  });

  it('has defaults for everything but the image, the secrets and the proxy', async () => {
    const config = sandboxesConfig(REQUIRED, silentLogger);

    expect(config.pod).toEqual({
      images: { default: REQUIRED.SANDBOX_IMAGE },
      runtimeClassName: 'gvisor',
      serviceAccountName: undefined,
      cpu: '2',
      memory: '4Gi',
      ephemeralStorage: '10Gi',
      volumeSize: '20Gi',
      storageClassName: undefined,
      snapshotClassName: undefined,
      uid: 1000,
      home: '/home/agent',
    });
    expect(config.namePrefix).toBe('sbx-');
    expect(config.agentPort).toBe(8100);
    expect(config.startTimeoutMs).toBe(300_000);
    expect(config.snapshotTimeoutMs).toBe(600_000);
    expect(await config.proxyUrl()).toBe('http://10.8.0.12:3128');
    expect(config.network.baseUrls).toEqual({
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
    });
  });

  it('takes an image per toolchain, and the hosts and base URLs of every sandbox', () => {
    const config = sandboxesConfig(
      {
        ...REQUIRED,
        SANDBOX_IMAGES: 'python=registry/sandbox-python:1, go=registry/sandbox-go:1',
        SANDBOX_ALLOWED_HOSTS: 'registry.npmjs.org, *.github.com',
        SANDBOX_BASE_URLS: 'ANTHROPIC_BASE_URL=https://gateway.example.com/anthropic',
        SANDBOX_STORAGE_CLASS: 'premium-rwo',
      },
      silentLogger,
    );

    expect(config.pod.images).toEqual({
      default: REQUIRED.SANDBOX_IMAGE,
      python: 'registry/sandbox-python:1',
      go: 'registry/sandbox-go:1',
    });
    expect(config.pod.storageClassName).toBe('premium-rwo');
    expect(config.network).toEqual({
      allowedHosts: ['registry.npmjs.org', '*.github.com'],
      baseUrls: { ANTHROPIC_BASE_URL: 'https://gateway.example.com/anthropic' },
    });
  });

  it('refuses a missing secret, a short one, or an image name it cannot label', () => {
    const { SANDBOX_SERVICE_TOKEN: _, ...withoutToken } = REQUIRED;
    expect(() => sandboxesConfig(withoutToken, silentLogger)).toThrow(
      'SANDBOX_SERVICE_TOKEN is required',
    );
    expect(() =>
      sandboxesConfig({ ...REQUIRED, SANDBOX_AGENT_SECRET: 'short' }, silentLogger),
    ).toThrow('SANDBOX_AGENT_SECRET: 32 characters at least.');
    expect(() =>
      sandboxesConfig({ ...REQUIRED, SANDBOX_IMAGES: 'Python=registry/python' }, silentLogger),
    ).toThrow('SANDBOX_IMAGES');
  });

  it('runs without gVisor only when told, and says so', () => {
    const warnings: string[] = [];
    const config = sandboxesConfig(
      { ...REQUIRED, SANDBOX_RUNTIME_CLASS: '' },
      { ...silentLogger, warn: (message: string) => warnings.push(message) },
    );

    expect(config.pod.runtimeClassName).toBeUndefined();
    expect(warnings).toEqual([
      'The sandboxes do not run under gVisor: their pods share the nodes’ kernel.',
    ]);
  });
});

describe('the credentials of the Kubernetes API', () => {
  it('are the service account Kubernetes mounts, its token read again once in a while', () => {
    const directory = mkdtempSync(join(tmpdir(), 'service-account-'));
    writeFileSync(join(directory, 'ca.crt'), 'certificate');
    writeFileSync(join(directory, 'namespace'), 'sandboxes\n');
    writeFileSync(join(directory, 'token'), 'token-1\n');

    const credentials = new KubernetesCredentials('service-account', directory);

    expect(credentials.ca).toBe('certificate');
    expect(credentials.namespace()).toBe('sandboxes');
    expect(credentials.bearer()).toBe('token-1');
    expect(new KubernetesCredentials('none').bearer()).toBeUndefined();
  });
});
