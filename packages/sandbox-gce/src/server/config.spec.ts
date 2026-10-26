import { afterEach, describe, expect, it, vi } from 'vitest';

import { silentLogger } from '../common/logger.js';
import { listenConfig, sandboxesConfig } from './config.js';

const REQUIRED = {
  SANDBOX_PROJECT: 'my-project',
  SANDBOX_ZONE: 'europe-west1-b',
  SANDBOX_IMAGE: 'ai-sdk-sandbox',
  SANDBOX_AGENT_SECRET: 'x'.repeat(32),
  SANDBOX_PROXY_URL: 'http://10.8.0.2:3128',
  SANDBOX_PROXY_ADMIN_URL: 'http://10.8.0.2:3129',
  SANDBOX_PROXY_TOKEN: 'proxy-token',
};

afterEach(() => vi.restoreAllMocks());

describe('the service configuration', () => {
  it('listens on every interface on Cloud Run, on the loopback elsewhere', () => {
    expect(listenConfig({ K_SERVICE: 'sandboxes', PORT: '9000' })).toEqual({
      port: 9000,
      host: '0.0.0.0',
      jsonLogs: true,
    });
    expect(listenConfig({})).toEqual({ port: 8080, host: '127.0.0.1', jsonLogs: false });
  });

  it('has defaults for everything but the zone, the image, the agents and the proxy', async () => {
    const config = await sandboxesConfig(REQUIRED, silentLogger);

    expect(config.machine).toEqual({
      machineType: 'e2-standard-4',
      images: { default: 'projects/my-project/global/images/ai-sdk-sandbox' },
      diskSizeGb: 20,
      diskType: 'pd-balanced',
      network: undefined,
      subnetwork: undefined,
      tags: ['ai-sdk-sandbox'],
      spot: false,
    });
    expect(config.instancePrefix).toBe('sbx-');
    expect(config.agentPort).toBe(8100);
    expect(config.startTimeoutMs).toBe(300_000);
    expect(config.network.baseUrls).toEqual({
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
    });
  });

  it('takes an image of another project, a family, and the hosts and base URLs of every sandbox', async () => {
    const config = await sandboxesConfig(
      {
        ...REQUIRED,
        SANDBOX_IMAGE: 'projects/images-project/global/images/family/sandbox',
        SANDBOX_ALLOWED_HOSTS: 'registry.npmjs.org, *.github.com',
        SANDBOX_BASE_URLS: 'GATEWAY_URL=https://gateway.example.com',
        SANDBOX_SPOT: 'true',
        SANDBOX_IMAGES: 'python=family/sandbox-python, go=projects/images-project/global/images/go',
      },
      silentLogger,
    );

    expect(config.machine.images).toEqual({
      default: 'projects/images-project/global/images/family/sandbox',
      python: 'projects/my-project/global/images/family/sandbox-python',
      go: 'projects/images-project/global/images/go',
    });
    expect(config.machine.spot).toBe(true);
    expect(config.network).toEqual({
      allowedHosts: ['registry.npmjs.org', '*.github.com'],
      baseUrls: { GATEWAY_URL: 'https://gateway.example.com' },
    });
  });

  it('says what is missing', async () => {
    await expect(sandboxesConfig({ ...REQUIRED, SANDBOX_ZONE: '' }, silentLogger)).rejects.toThrow(
      'SANDBOX_ZONE is required',
    );
    await expect(
      sandboxesConfig({ ...REQUIRED, SANDBOX_AGENT_SECRET: 'short' }, silentLogger),
    ).rejects.toThrow('32 characters at least');
    await expect(
      sandboxesConfig({ ...REQUIRED, SANDBOX_BASE_URLS: 'nope' }, silentLogger),
    ).rejects.toThrow('is not NAME=url');
    await expect(
      sandboxesConfig({ ...REQUIRED, SANDBOX_IMAGES: 'Python=x' }, silentLogger),
    ).rejects.toThrow('is not NAME=image');
  });

  it('reads the project from the metadata server on Google Cloud, and needs it elsewhere', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('gcp-project\n'))
      .mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND'));
    const env = { ...REQUIRED, SANDBOX_PROJECT: '', K_SERVICE: 'sandboxes' };

    const config = await sandboxesConfig(env, silentLogger);

    expect(config.machine.images).toEqual({
      default: 'projects/gcp-project/global/images/ai-sdk-sandbox',
    });
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/project/project-id'),
      expect.objectContaining({ headers: { 'metadata-flavor': 'Google' } }),
    );
    await expect(sandboxesConfig(env, silentLogger)).rejects.toThrow(
      'SANDBOX_PROJECT is required off Google Cloud',
    );
  });

  it('says that spot machines may stop at any time', async () => {
    const info = vi.fn();

    const config = await sandboxesConfig(
      { ...REQUIRED, SANDBOX_SPOT: 'true' },
      { ...silentLogger, info },
    );

    expect(config.machine.spot).toBe(true);
    expect(info).toHaveBeenCalledWith(expect.stringContaining('SANDBOX_SPOT=true'));
  });
});
