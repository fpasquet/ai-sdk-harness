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
      spotFallback: true,
    });
    expect(config.instancePrefix).toBe('sbx-');
    expect(config.agentPort).toBe(8100);
    expect(config.startTimeoutMs).toBe(300_000);
    expect(config.reconcileEveryMs).toBe(600_000);
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
        SANDBOX_SPOT_FALLBACK: 'false',
        SANDBOX_MAX_RUNNING: '10',
        SANDBOX_MAX_RUN_HOURS: '1.5',
        SANDBOX_RECONCILE_MINUTES: '0',
        SANDBOX_PROXY_INSTANCE: 'sandbox-proxy',
        SANDBOX_IMAGES: 'python=family/sandbox-python, go=projects/images-project/global/images/go',
      },
      silentLogger,
    );

    expect(config.machine.images).toEqual({
      default: 'projects/images-project/global/images/family/sandbox',
      python: 'projects/my-project/global/images/family/sandbox-python',
      go: 'projects/images-project/global/images/go',
    });
    expect(config.machine).toMatchObject({ spot: true, spotFallback: false });
    expect(config.maxRunning).toBe(10);
    expect(config.machine.maxRunSeconds).toBe(5400);
    expect(config.proxyInstance).toBe('sandbox-proxy');
    expect(config.reconcileEveryMs).toBeUndefined();
    expect(config.network).toEqual({
      allowedHosts: ['registry.npmjs.org', '*.github.com'],
      baseUrls: { GATEWAY_URL: 'https://gateway.example.com' },
    });
  });

  it('refuses a limit of running sandboxes that is no positive integer', async () => {
    await expect(
      sandboxesConfig({ ...REQUIRED, SANDBOX_MAX_RUNNING: '0' }, silentLogger),
    ).rejects.toThrow('SANDBOX_MAX_RUNNING: `0` is not a positive integer.');
  });

  it('trades speed for cost by its profile, cost by default, each setting of it overridable', async () => {
    const info = vi.fn();
    const logger = { ...silentLogger, info };
    const settings = async (env: Record<string, string>) => {
      const { warmPool, proxyAlwaysOn } = await sandboxesConfig({ ...REQUIRED, ...env }, logger);
      return { warmPool, proxyAlwaysOn };
    };

    expect(await settings({})).toEqual({ warmPool: 0, proxyAlwaysOn: false });
    expect(await settings({ SANDBOX_PROFILE: 'cost' })).toEqual({
      warmPool: 0,
      proxyAlwaysOn: false,
    });
    expect(info).not.toHaveBeenCalledWith(expect.stringContaining('SANDBOX_WARM_POOL'));
    expect(await settings({ SANDBOX_PROFILE: 'fast' })).toEqual({
      warmPool: 1,
      proxyAlwaysOn: true,
    });
    expect(info).toHaveBeenCalledWith(
      'SANDBOX_WARM_POOL=1: a machine is kept booted from each template in use, billed all the time.',
    );
    expect(
      await settings({
        SANDBOX_PROFILE: 'fast',
        SANDBOX_WARM_POOL: '0',
        SANDBOX_PROXY_ALWAYS_ON: 'false',
      }),
    ).toEqual({ warmPool: 0, proxyAlwaysOn: false });
    expect(await settings({ SANDBOX_WARM_POOL: '2' })).toEqual({
      warmPool: 2,
      proxyAlwaysOn: false,
    });
  });

  it('refuses a profile it does not know, a pool that is no whole number, a flag neither true nor false', async () => {
    await expect(
      sandboxesConfig({ ...REQUIRED, SANDBOX_PROFILE: 'cheap' }, silentLogger),
    ).rejects.toThrow('SANDBOX_PROFILE: `cheap` is neither `cost` nor `fast`.');
    await expect(
      sandboxesConfig({ ...REQUIRED, SANDBOX_WARM_POOL: '1.5' }, silentLogger),
    ).rejects.toThrow('SANDBOX_WARM_POOL: `1.5` is not a whole number of machines.');
    await expect(
      sandboxesConfig({ ...REQUIRED, SANDBOX_WARM_POOL: '-1' }, silentLogger),
    ).rejects.toThrow('SANDBOX_WARM_POOL: `-1` is not a whole number of machines.');
    await expect(
      sandboxesConfig({ ...REQUIRED, SANDBOX_PROXY_ALWAYS_ON: 'yes' }, silentLogger),
    ).rejects.toThrow('SANDBOX_PROXY_ALWAYS_ON: `yes` is neither `true` nor `false`.');
  });

  it('refuses a reconciliation period that is no number of minutes', async () => {
    await expect(
      sandboxesConfig({ ...REQUIRED, SANDBOX_RECONCILE_MINUTES: 'often' }, silentLogger),
    ).rejects.toThrow('SANDBOX_RECONCILE_MINUTES: `often` is not a number of minutes.');
  });

  it('refuses a run limit under 30 s', async () => {
    await expect(
      sandboxesConfig({ ...REQUIRED, SANDBOX_MAX_RUN_HOURS: '0.001' }, silentLogger),
    ).rejects.toThrow('SANDBOX_MAX_RUN_HOURS: `0.001` is not a number of hours, 30 s at least.');
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
    const env = {
      ...REQUIRED,
      SANDBOX_PROJECT: '',
      K_SERVICE: 'sandboxes',
      SANDBOX_SERVICE_TOKEN: 'service-token',
    };

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

  it('demands a service token on Cloud Run, unless told to go without', async () => {
    const warn = vi.fn();
    const onCloudRun = { ...REQUIRED, K_SERVICE: 'sandboxes' };

    await expect(sandboxesConfig(onCloudRun, silentLogger)).rejects.toThrow(
      'SANDBOX_SERVICE_TOKEN is required on Cloud Run',
    );
    const open = await sandboxesConfig(
      { ...onCloudRun, SANDBOX_INSECURE_NO_TOKEN: 'true' },
      { ...silentLogger, warn },
    );
    const local = await sandboxesConfig(REQUIRED, silentLogger);

    expect(open.serviceToken).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('SANDBOX_INSECURE_NO_TOKEN=true'));
    expect(local.serviceToken).toBeUndefined();
  });

  it('warns when every sandbox may reach any host', async () => {
    const warn = vi.fn();

    await sandboxesConfig({ ...REQUIRED, SANDBOX_ALLOWED_HOSTS: '*' }, { ...silentLogger, warn });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('SANDBOX_ALLOWED_HOSTS holds `*`'));
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
