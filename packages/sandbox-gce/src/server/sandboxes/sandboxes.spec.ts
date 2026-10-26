import type { Mock } from 'vitest';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ComputeApi, Image, Instance } from '../compute/compute-api.js';
import type { ProxyAdmin } from './proxy-admin.js';
import type { MachineSettings, SandboxesOptions } from './sandboxes.js';

import { silentLogger } from '../../common/logger.js';
import { PROTOCOL_VERSION } from '../../protocol/version.js';
import { ComputeError } from '../compute/compute-error.js';
import { AgentClient } from './agent-client.js';
import { Sandboxes } from './sandboxes.js';

// The waits between two polls of a machine or an agent pass at once.
vi.mock('node:timers/promises', () => ({ setTimeout: () => Promise.resolve() }));

afterEach(() => vi.restoreAllMocks());

const sandbox = (status: string, labels: Record<string, string> = {}): Instance => ({
  name: 'sbx-box',
  status,
  labels: { 'ai-sdk-sandbox': 'sandbox', ...labels },
  networkInterfaces: [{ networkIP: '10.0.0.3' }],
});

/** Each method of `T` as a mock, its calls for the tests to check. */
type Stub<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R ? Mock<(...args: A) => R> : T[K];
};

const image: Image = { name: 'sandbox-v1', selfLink: 'projects/p/global/images/sandbox-v1' };

/** A Compute Engine whose instance `sbx-box` goes through `statuses`, the last one kept. */
function computeOf(statuses: (Instance | undefined)[] = []): Stub<ComputeApi> {
  return {
    getInstance: vi.fn(() => Promise.resolve(statuses.length > 1 ? statuses.shift() : statuses[0])),
    insertInstance: vi.fn(() => Promise.resolve()),
    startInstance: vi.fn(() => Promise.resolve()),
    resumeInstance: vi.fn(() => Promise.resolve()),
    stopInstance: vi.fn(() => Promise.resolve()),
    deleteInstance: vi.fn(() => Promise.resolve()),
    getImage: vi.fn((_path: string): Promise<Image | undefined> => Promise.resolve(image)),
    imagePath: vi.fn((name: string) => `projects/p/global/images/${name}`),
    insertImage: vi.fn(() => Promise.resolve()),
    deleteImage: vi.fn(() => Promise.resolve()),
  };
}

function proxyOf(): Stub<ProxyAdmin> {
  return {
    register: vi.fn(() => Promise.resolve()),
    setAllowedHosts: vi.fn(() => Promise.resolve()),
    addTransformations: vi.fn(() => Promise.resolve()),
    setTransformations: vi.fn(() => Promise.resolve()),
    holdsSecret: vi.fn(() => Promise.resolve(false)),
    remove: vi.fn(() => Promise.resolve()),
  };
}

const machine: MachineSettings = {
  machineType: 'e2-standard-4',
  images: { default: 'projects/p/global/images/family/sandbox' },
  diskSizeGb: 20,
  diskType: 'pd-balanced',
  tags: ['ai-sdk-sandbox'],
  spot: false,
};

function sandboxesOf({
  compute = computeOf(),
  proxy = proxyOf(),
  ...overrides
}: Partial<Omit<SandboxesOptions, 'compute' | 'proxy'>> & {
  compute?: Stub<ComputeApi>;
  proxy?: Stub<ProxyAdmin>;
} = {}): Sandboxes {
  return new Sandboxes({
    compute: compute as unknown as ComputeApi,
    proxy: proxy as unknown as ProxyAdmin,
    logger: silentLogger,
    zone: 'z',
    machine,
    instancePrefix: 'sbx-',
    agentSecret: 'a-secret',
    agentPort: 8100,
    proxyUrl: 'http://10.0.0.2:3128',
    network: { allowedHosts: ['registry.npmjs.org'], baseUrls: {} },
    startTimeoutMs: 15_000,
    ...overrides,
  });
}

/** An agent that answers at once, in the service's protocol. */
function agentAnswers(protocol: number | undefined): void {
  vi.spyOn(AgentClient.prototype, 'health').mockResolvedValue(protocol);
  vi.spyOn(AgentClient.prototype, 'configure').mockResolvedValue({
    home: '/home/sandbox',
    workingDirectory: '/home/sandbox/workspace',
  });
}

describe('the sandboxes of the service', () => {
  it('needs a default image and a short instance prefix', () => {
    expect(() => sandboxesOf({ machine: { ...machine, images: {} } })).toThrow(
      'need a "default" image',
    );
    expect(() => sandboxesOf({ instancePrefix: 'Too-long-prefix' })).toThrow('instance prefix');
  });

  it('finds no agent for a sandbox whose machine does not run', async () => {
    const compute = computeOf([sandbox('TERMINATED')]);

    await expect(sandboxesOf({ compute }).agent('box')).rejects.toMatchObject({ status: 404 });
  });

  it('reaches the agent at the internal address of the machine, then remembers it', async () => {
    const compute = computeOf([sandbox('RUNNING')]);
    const sandboxes = sandboxesOf({ compute });

    const agent = await sandboxes.agent('box');
    await sandboxes.agent('box');

    expect(agent.endpoint).toMatchObject({ host: '10.0.0.3', port: 8100 });
    expect(compute.getInstance).toHaveBeenCalledTimes(1);
  });

  it('creates a machine on a private network, as a spot one when asked', async () => {
    agentAnswers(PROTOCOL_VERSION);
    const compute = computeOf([undefined, sandbox('RUNNING')]);
    const proxy = proxyOf();
    const sandboxes = sandboxesOf({
      compute,
      proxy,
      machine: { ...machine, network: 'vpc', subnetwork: 'sandboxes', spot: true },
    });

    await expect(sandboxes.create('box', { allowedHosts: ['github.com'] })).resolves.toEqual({
      name: 'box',
      home: '/home/sandbox',
      workingDirectory: '/home/sandbox/workspace',
    });

    expect(compute.insertInstance).toHaveBeenCalledWith(
      expect.objectContaining({
        networkInterfaces: [{ network: 'vpc', subnetwork: 'sandboxes' }],
        scheduling: expect.objectContaining({ provisioningModel: 'SPOT' }) as unknown,
      }),
    );
    expect(proxy.register).toHaveBeenCalledWith('box', {
      address: '10.0.0.3',
      allowedHosts: ['registry.npmjs.org', 'github.com'],
      baseUrls: {},
    });
  });

  it('refuses a name taken meanwhile, and an image the service does not offer', async () => {
    const compute = computeOf([undefined]);
    compute.insertInstance.mockRejectedValueOnce(new ComputeError(409, 'exists'));
    const sandboxes = sandboxesOf({ compute });

    await expect(sandboxes.create('box', {})).rejects.toMatchObject({ status: 409 });
    await expect(sandboxes.create('box', { image: 'python' })).rejects.toThrow(
      'No image "python" on this service. It offers: default.',
    );
  });

  it('passes on any other failure to create a machine', async () => {
    const compute = computeOf([undefined]);
    compute.insertInstance.mockRejectedValueOnce(new ComputeError(403, 'quota'));

    await expect(sandboxesOf({ compute }).create('box', {})).rejects.toMatchObject({
      status: 403,
    });
  });

  it('deletes a machine that started without an address', async () => {
    const compute = computeOf([undefined, { ...sandbox('RUNNING'), networkInterfaces: [] }]);

    await expect(sandboxesOf({ compute }).create('box', {})).rejects.toMatchObject({
      status: 503,
    });
    expect(compute.deleteInstance).toHaveBeenCalledWith('sbx-box');
  });

  it('refuses an agent of another protocol, and one that does not answer', async () => {
    const compute = (): Stub<ComputeApi> => computeOf([undefined, sandbox('RUNNING')]);
    agentAnswers(PROTOCOL_VERSION + 1);
    await expect(sandboxesOf({ compute: compute() }).create('box', {})).rejects.toMatchObject({
      status: 502,
    });

    agentAnswers(undefined);
    await expect(
      sandboxesOf({ compute: compute(), startTimeoutMs: -1 }).create('box', {}),
    ).rejects.toMatchObject({ status: 504 });
  });

  it('creates a sandbox from a template made on its image, and refuses a missing one', async () => {
    agentAnswers(PROTOCOL_VERSION);
    const compute = computeOf([undefined, sandbox('RUNNING')]);
    const sandboxes = sandboxesOf({ compute });

    await sandboxes.create('box', { template: 'deps' });

    const [body] = compute.insertInstance.mock.calls[0] ?? [];
    expect(JSON.stringify(body)).toMatch(
      /"sourceImage":"projects\/p\/global\/images\/deps-[0-9a-f]{8}"/,
    );

    const pending = computeOf([undefined]);
    pending.getImage.mockImplementation((path) =>
      Promise.resolve(path.includes('deps-') ? { ...image, status: 'PENDING' } : image),
    );
    await expect(
      sandboxesOf({ compute: pending }).create('box', { template: 'deps' }),
    ).rejects.toThrow('No template "deps" on the image "default".');
  });

  it('refuses templates when the base image is gone', async () => {
    const compute = computeOf();
    compute.getImage.mockResolvedValue(undefined);

    await expect(sandboxesOf({ compute }).templateExists('deps')).rejects.toMatchObject({
      status: 500,
    });
  });

  it('starts a stopped machine, resumes a suspended one, and waits for one on its way', async () => {
    agentAnswers(PROTOCOL_VERSION);
    const compute = computeOf([
      sandbox('TERMINATED'),
      sandbox('SUSPENDED'),
      sandbox('STAGING'),
      sandbox('RUNNING'),
    ]);

    await sandboxesOf({ compute }).resume('box', {});

    expect(compute.startInstance).toHaveBeenCalledWith('sbx-box');
    expect(compute.resumeInstance).toHaveBeenCalledWith('sbx-box');
  });

  it('cannot resume a sandbox that is gone, not the service own, or stuck', async () => {
    const resume = (instance: Instance | undefined, startTimeoutMs = 15_000) =>
      sandboxesOf({ compute: computeOf([instance]), startTimeoutMs }).resume('box', {});

    await expect(resume(undefined)).rejects.toMatchObject({ status: 404 });
    await expect(resume({ ...sandbox('RUNNING'), labels: {} })).rejects.toMatchObject({
      status: 404,
    });
    await expect(resume(sandbox('STAGING'), -1)).rejects.toMatchObject({ status: 503 });
    await expect(resume(sandbox('UNKNOWN'))).rejects.toThrow('is UNKNOWN: try again later');
  });

  it('suspends a running machine once, and nothing that is gone', async () => {
    const compute = computeOf([undefined, sandbox('RUNNING'), sandbox('TERMINATED')]);
    const proxy = proxyOf();
    proxy.remove.mockRejectedValue(new Error('unreachable'));
    const warn = vi.fn();
    const sandboxes = sandboxesOf({ compute, proxy, logger: { ...silentLogger, warn } });

    await sandboxes.suspend('box');
    await sandboxes.suspend('box');
    await sandboxes.suspend('box');

    expect(compute.stopInstance).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('The proxy could not forget box: Error: unreachable');
  });

  it('passes on what a sandbox may reach and its credentials to the proxy', async () => {
    const proxy = proxyOf();
    const sandboxes = sandboxesOf({ proxy });
    const transformation = { match: { host: 'api.example.com' }, transform: { headers: {} } };

    await sandboxes.setAllowedHosts('box', ['github.com']);
    await sandboxes.addTransformations('box', [transformation]);
    await sandboxes.setTransformations('box', []);
    proxy.holdsSecret.mockResolvedValue(true);

    expect(proxy.setAllowedHosts).toHaveBeenCalledWith('box', ['registry.npmjs.org', 'github.com']);
    expect(proxy.addTransformations).toHaveBeenCalledWith('box', [transformation]);
    expect(proxy.setTransformations).toHaveBeenCalledWith('box', []);
    await expect(sandboxes.assertNoSecret('box', ['echo secret'])).rejects.toMatchObject({
      status: 400,
    });
  });

  it('saves a template on the image of its builder, a concurrent save as good', async () => {
    const compute = computeOf([
      undefined,
      sandbox('RUNNING', { 'ai-sdk-sandbox-image': 'default' }),
    ]);
    compute.insertImage.mockRejectedValueOnce(new ComputeError(409, 'exists'));
    const sandboxes = sandboxesOf({ compute });

    await expect(sandboxes.saveTemplate('box', 'deps')).rejects.toMatchObject({ status: 404 });
    await sandboxes.saveTemplate('box', 'deps');

    expect(compute.stopInstance).toHaveBeenCalledWith('sbx-box');
    compute.insertImage.mockRejectedValueOnce(new ComputeError(403, 'quota'));
    await expect(sandboxes.saveTemplate('box', 'deps')).rejects.toMatchObject({ status: 403 });
  });

  it('saves the template of a machine without an image label on the default image', async () => {
    const compute = computeOf([{ ...sandbox('RUNNING'), labels: { 'ai-sdk-sandbox': 'sandbox' } }]);

    await sandboxesOf({ compute }).saveTemplate('box', 'deps');

    expect(compute.insertImage).toHaveBeenCalledWith(
      expect.stringMatching(/^deps-[0-9a-f]{8}$/),
      'sbx-box',
      expect.objectContaining({ 'ai-sdk-sandbox-image': 'default' }),
    );
  });

  it('deletes a template, and refuses an invalid id', async () => {
    const compute = computeOf();
    const sandboxes = sandboxesOf({ compute });

    await sandboxes.deleteTemplate('deps');

    expect(compute.deleteImage).toHaveBeenCalledWith(expect.stringMatching(/^deps-[0-9a-f]{8}$/));
    await expect(sandboxes.deleteTemplate('Not_Valid')).rejects.toMatchObject({ status: 400 });
  });
});
