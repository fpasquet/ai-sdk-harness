import type { Mock } from 'vitest';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ProxySandbox } from '../../protocol/proxy.js';
import type { ComputeApi, Image, Instance } from '../compute/compute-api.js';
import type { ProxyAdmin } from './proxy-admin.js';
import type { MachineSettings, SandboxesOptions } from './sandboxes.js';

import { silentLogger } from '../../common/logger.js';
import { PROTOCOL_VERSION } from '../../protocol/version.js';
import { ComputeError } from '../compute/compute-error.js';
import { AgentClient, agentToken } from './agent-client.js';
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

/**
 * A Compute Engine whose instance `sbx-box` goes through `statuses`, the last one kept: a stop
 * leaves it stopped, a deletion gone.
 */
function computeOf(statuses: (Instance | undefined)[] = []): Stub<ComputeApi> {
  return {
    getInstance: vi.fn(() => Promise.resolve(statuses.length > 1 ? statuses.shift() : statuses[0])),
    listInstances: vi.fn((): Promise<Instance[]> => Promise.resolve([])),
    insertInstance: vi.fn(() => Promise.resolve()),
    startInstance: vi.fn(() => Promise.resolve()),
    resumeInstance: vi.fn(() => Promise.resolve()),
    stopInstance: vi.fn(() => {
      statuses.splice(0, statuses.length, sandbox('TERMINATED'));
      return Promise.resolve();
    }),
    setScheduling: vi.fn(() => Promise.resolve()),
    setMetadata: vi.fn(() => Promise.resolve()),
    setLabels: vi.fn(() => Promise.resolve()),
    deleteInstance: vi.fn(() => {
      statuses.splice(0, statuses.length, undefined);
      return Promise.resolve();
    }),
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
    list: vi.fn((): Promise<ProxySandbox[] | undefined> => Promise.resolve([])),
    healthy: vi.fn(() => Promise.resolve(true)),
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

  it("proves itself to an agent with the token of the machine's run", async () => {
    const run = { key: 'ai-sdk-sandbox-agent-run', value: 'r1' };
    const drawn = { ...sandbox('RUNNING'), metadata: { items: [run] } };

    const agent = await sandboxesOf({ compute: computeOf([drawn]) }).agent('box');
    const older = await sandboxesOf({ compute: computeOf([sandbox('RUNNING')]) }).agent('box');

    expect(agent.endpoint.token).toBe(agentToken('a-secret', 'sbx-box', 'r1'));
    // A machine made before runs were drawn keeps the token it has.
    expect(older.endpoint.token).toBe(agentToken('a-secret', 'sbx-box'));
  });

  /**
   * A Compute Engine holding machines by name, `status` each, which a start, a stop, an insert or a
   * deletion moves on: the sandboxes and the proxy's machine.
   */
  function machinesOf(initial: Record<string, string>): Stub<ComputeApi> {
    const machines = new Map(Object.entries(initial));
    const compute = computeOf();
    const instance = (name: string): Instance | undefined => {
      const status = machines.get(name);
      return status === undefined ? undefined : { ...sandbox(status), name };
    };
    compute.getInstance.mockImplementation((name: string) => Promise.resolve(instance(name)));
    compute.listInstances.mockImplementation(() =>
      Promise.resolve(
        [...machines.keys()]
          .filter((name) => name.startsWith('sbx-'))
          .flatMap((name) => {
            const found = instance(name);
            return found === undefined ? [] : [found];
          }),
      ),
    );
    compute.insertInstance.mockImplementation((body: Record<string, unknown>) => {
      machines.set(body['name'] as string, 'RUNNING');
      return Promise.resolve();
    });
    compute.startInstance.mockImplementation((name: string) => {
      machines.set(name, 'RUNNING');
      return Promise.resolve();
    });
    compute.stopInstance.mockImplementation((name: string) => {
      machines.set(name, 'TERMINATED');
      return Promise.resolve();
    });
    compute.deleteInstance.mockImplementation((name: string) => {
      machines.delete(name);
      return Promise.resolve();
    });
    return compute;
  }

  it('starts the stopped proxy with a sandbox, and stops it with the last one', async () => {
    agentAnswers(PROTOCOL_VERSION);
    const compute = machinesOf({ 'sandbox-proxy': 'TERMINATED', 'sbx-other': 'TERMINATED' });
    const proxy = proxyOf();
    const sandboxes = sandboxesOf({ compute, proxy, proxyInstance: 'sandbox-proxy' });

    await sandboxes.create('box', {});
    expect(compute.startInstance).toHaveBeenCalledWith('sandbox-proxy');
    expect(proxy.healthy).toHaveBeenCalled();

    await sandboxes.delete('box');
    expect(compute.stopInstance).toHaveBeenCalledWith('sandbox-proxy', { wait: false });
  });

  it('starts the stopped proxy ahead of a sandbox, without waiting for it', async () => {
    const compute = machinesOf({ 'sandbox-proxy': 'TERMINATED' });
    const proxy = proxyOf();

    await sandboxesOf({ compute, proxy, proxyInstance: 'sandbox-proxy' }).prepare();
    expect(compute.startInstance).toHaveBeenCalledWith('sandbox-proxy', { wait: false });
    expect(proxy.healthy).not.toHaveBeenCalled();

    const running = machinesOf({ 'sandbox-proxy': 'RUNNING' });
    await sandboxesOf({ compute: running, proxyInstance: 'sandbox-proxy' }).prepare();
    const alwaysOn = machinesOf({});
    await sandboxesOf({ compute: alwaysOn }).prepare();
    expect(running.startInstance).not.toHaveBeenCalled();
    expect(alwaysOn.getInstance).not.toHaveBeenCalled();
  });

  it('keeps the proxy running while another sandbox runs, and leaves a stopped one alone', async () => {
    const compute = machinesOf({
      'sandbox-proxy': 'RUNNING',
      'sbx-box': 'RUNNING',
      'sbx-other': 'RUNNING',
    });
    const sandboxes = sandboxesOf({ compute, proxyInstance: 'sandbox-proxy' });

    await sandboxes.suspend('box');
    expect(compute.stopInstance).not.toHaveBeenCalledWith('sandbox-proxy', { wait: false });

    const idle = machinesOf({ 'sandbox-proxy': 'TERMINATED', 'sbx-box': 'RUNNING' });
    await sandboxesOf({ compute: idle, proxyInstance: 'sandbox-proxy' }).suspend('box');
    expect(idle.stopInstance).not.toHaveBeenCalledWith('sandbox-proxy', { wait: false });
  });

  it('waits for the proxy to answer, and says when it is missing or never answers', async () => {
    agentAnswers(PROTOCOL_VERSION);
    const proxy = proxyOf();
    proxy.healthy.mockResolvedValueOnce(false);
    const compute = machinesOf({ 'sandbox-proxy': 'RUNNING' });
    const sandboxes = sandboxesOf({ compute, proxy, proxyInstance: 'sandbox-proxy' });

    await sandboxes.create('box', {});
    // Asked again until it answers: once early, while the machine boots, and before registering.
    expect(proxy.healthy.mock.calls.length).toBeGreaterThan(2);

    const missing = machinesOf({});
    await expect(
      sandboxesOf({ compute: missing, proxyInstance: 'sandbox-proxy' }).resume('box', {}),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      sandboxesOf({
        compute: machinesOf({ 'sbx-box': 'TERMINATED' }),
        proxyInstance: 'sandbox-proxy',
      }).resume('box', {}),
    ).rejects.toMatchObject({ status: 500 });
    const silent = proxyOf();
    silent.healthy.mockResolvedValue(false);
    await expect(
      sandboxesOf({
        compute: machinesOf({ 'sbx-box': 'TERMINATED', 'sandbox-proxy': 'RUNNING' }),
        proxy: silent,
        proxyInstance: 'sandbox-proxy',
        startTimeoutMs: -1,
      }).resume('box', {}),
    ).rejects.toMatchObject({ status: 504 });
  });

  it('limits how long a machine runs at a time, Spot or standard', async () => {
    agentAnswers(PROTOCOL_VERSION);
    const limit = { maxRunDuration: { seconds: '3600' }, instanceTerminationAction: 'STOP' };
    const spot = computeOf([undefined, sandbox('RUNNING')]);
    await sandboxesOf({
      compute: spot,
      machine: { ...machine, spot: true, maxRunSeconds: 3600 },
    }).create('box', {});
    expect(spot.insertInstance).toHaveBeenCalledWith(
      expect.objectContaining({ scheduling: expect.objectContaining(limit) as unknown }),
      { wait: true },
    );

    const standard = computeOf([undefined, sandbox('RUNNING')]);
    await sandboxesOf({ compute: standard, machine: { ...machine, maxRunSeconds: 3600 } }).create(
      'box',
      {},
    );
    expect(standard.insertInstance).toHaveBeenCalledWith(
      expect.objectContaining({ scheduling: expect.objectContaining(limit) as unknown }),
      { wait: true },
    );

    const exhausted = computeOf([sandbox('TERMINATED'), sandbox('RUNNING')]);
    exhausted.startInstance.mockRejectedValueOnce(
      new ComputeError(503, 'no capacity', 'ZONE_RESOURCE_POOL_EXHAUSTED'),
    );
    await sandboxesOf({
      compute: exhausted,
      machine: { ...machine, spot: true, maxRunSeconds: 3600 },
    }).resume('box', {});
    expect(exhausted.setScheduling).toHaveBeenCalledWith(
      'sbx-box',
      expect.objectContaining({ provisioningModel: 'STANDARD', ...limit }),
    );
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
      { wait: true },
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
    expect(compute.deleteInstance).toHaveBeenCalledWith('sbx-box', { wait: false });
  });

  it('creates a standard machine when the zone has no Spot capacity left', async () => {
    agentAnswers(PROTOCOL_VERSION);
    const compute = computeOf([undefined, sandbox('RUNNING')]);
    compute.insertInstance.mockRejectedValueOnce(
      new ComputeError(503, 'no capacity', 'ZONE_RESOURCE_POOL_EXHAUSTED'),
    );
    const warn = vi.fn();
    const sandboxes = sandboxesOf({
      compute,
      machine: { ...machine, spot: true },
      logger: { ...silentLogger, warn },
    });

    await sandboxes.create('box', {});

    const [, [standard] = []] = compute.insertInstance.mock.calls as unknown as [
      unknown,
      [{ scheduling: unknown }],
    ];
    expect(standard?.scheduling).toEqual({ automaticRestart: true, onHostMaintenance: 'MIGRATE' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('as a standard machine'));
  });

  it('fails without Spot capacity when told not to fall back, or for a standard machine', async () => {
    const exhausted = (): Stub<ComputeApi> => {
      const compute = computeOf([undefined]);
      compute.insertInstance.mockRejectedValue(
        new ComputeError(503, 'no capacity', 'ZONE_RESOURCE_POOL_EXHAUSTED'),
      );
      return compute;
    };

    await expect(
      sandboxesOf({
        compute: exhausted(),
        machine: { ...machine, spot: true, spotFallback: false },
      }).create('box', {}),
    ).rejects.toMatchObject({ status: 503 });
    await expect(sandboxesOf({ compute: exhausted() }).create('box', {})).rejects.toMatchObject({
      status: 503,
    });
  });

  it('refuses to create or start a sandbox beyond the most running at once', async () => {
    agentAnswers(PROTOCOL_VERSION);
    const others = [sandbox('RUNNING'), sandbox('STAGING'), sandbox('TERMINATED')];
    const full = computeOf([undefined]);
    full.listInstances.mockResolvedValue(others);

    await expect(
      sandboxesOf({ compute: full, maxRunning: 2 }).create('box', {}),
    ).rejects.toMatchObject({
      status: 429,
      message: expect.stringContaining('SANDBOX_MAX_RUNNING=2') as unknown,
    });
    expect(full.insertInstance).not.toHaveBeenCalled();
    expect(full.listInstances).toHaveBeenCalledWith('ai-sdk-sandbox', 'sandbox');

    const stopped = computeOf([sandbox('TERMINATED')]);
    stopped.listInstances.mockResolvedValue(others);
    await expect(
      sandboxesOf({ compute: stopped, maxRunning: 2 }).resume('box', {}),
    ).rejects.toMatchObject({ status: 429 });
    expect(stopped.startInstance).not.toHaveBeenCalled();

    const room = computeOf([undefined, sandbox('RUNNING')]);
    room.listInstances.mockResolvedValue(others);
    await sandboxesOf({ compute: room, maxRunning: 3 }).create('box', {});
    expect(room.insertInstance).toHaveBeenCalledTimes(1);
  });

  it('waits for a machine on its way out before taking its name, and refuses one that stays', async () => {
    agentAnswers(PROTOCOL_VERSION);
    const compute = computeOf([sandbox('STOPPING'), undefined, sandbox('RUNNING')]);

    await sandboxesOf({ compute }).create('box', {});
    expect(compute.insertInstance).toHaveBeenCalledTimes(1);

    const stuck = computeOf([sandbox('STOPPING')]);
    await expect(
      sandboxesOf({ compute: stuck, startTimeoutMs: -1 }).create('box', {}),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      sandboxesOf({ compute: computeOf([sandbox('TERMINATED')]) }).create('box', {}),
    ).rejects.toMatchObject({ status: 409 });
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

  it('starts a stopped Spot machine as a standard one when the zone has no Spot capacity', async () => {
    agentAnswers(PROTOCOL_VERSION);
    const compute = computeOf([sandbox('TERMINATED'), sandbox('RUNNING')]);
    compute.startInstance.mockRejectedValueOnce(
      new ComputeError(503, 'no capacity', 'ZONE_RESOURCE_POOL_EXHAUSTED'),
    );

    await sandboxesOf({ compute, machine: { ...machine, spot: true } }).resume('box', {});

    expect(compute.setScheduling).toHaveBeenCalledWith('sbx-box', {
      automaticRestart: true,
      onHostMaintenance: 'MIGRATE',
      provisioningModel: 'STANDARD',
      preemptible: false,
      instanceTerminationAction: null,
    });
    expect(compute.startInstance).toHaveBeenCalledTimes(2);
  });

  it('passes on any other failure to start a machine', async () => {
    const compute = computeOf([sandbox('TERMINATED')]);
    compute.startInstance.mockRejectedValueOnce(new ComputeError(403, 'quota', 'QUOTA_EXCEEDED'));

    await expect(
      sandboxesOf({ compute, machine: { ...machine, spot: true } }).resume('box', {}),
    ).rejects.toMatchObject({ status: 403 });
    expect(compute.setScheduling).not.toHaveBeenCalled();
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
    expect(compute.stopInstance).toHaveBeenCalledWith('sbx-box', { wait: false });
    expect(warn).toHaveBeenCalledWith('The proxy could not forget box: Error: unreachable');
  });

  it("draws a new agent token at each stop, the machine's other metadata kept", async () => {
    const running = {
      ...sandbox('RUNNING'),
      metadata: {
        fingerprint: 'f1',
        items: [
          { key: 'ai-sdk-sandbox-agent-token', value: 'old' },
          { key: 'ai-sdk-sandbox-agent-run', value: 'r0' },
          { key: 'block-project-ssh-keys', value: 'true' },
        ],
      },
    };
    const compute = computeOf([running, { ...running, status: 'STOPPING' }]);
    compute.stopInstance.mockResolvedValue();

    await sandboxesOf({ compute }).suspend('box');

    const [[instance, metadata]] = compute.setMetadata.mock.calls as unknown as [
      [string, { fingerprint: string; items: { key: string; value: string }[] }],
    ];
    const value = (key: string): string | undefined =>
      metadata.items.find((item) => item.key === key)?.value;
    const run = value('ai-sdk-sandbox-agent-run') ?? '';
    expect(instance).toBe('sbx-box');
    expect(metadata.fingerprint).toBe('f1');
    expect(run).toMatch(/^[0-9a-f]{16}$/);
    expect(value('ai-sdk-sandbox-agent-token')).toBe(agentToken('a-secret', 'sbx-box', run));
    expect(value('block-project-ssh-keys')).toBe('true');
    expect(metadata.items).toHaveLength(3);
  });

  it('leaves the token of an agent that runs on, and stops even when no token is drawn', async () => {
    const suspended = computeOf([sandbox('SUSPENDED')]);
    suspended.stopInstance.mockResolvedValue();
    await sandboxesOf({ compute: suspended }).suspend('box');
    expect(suspended.setMetadata).not.toHaveBeenCalled();

    const raced = computeOf([sandbox('TERMINATED')]);
    raced.setMetadata.mockRejectedValue(new ComputeError(412, 'fingerprint does not match'));
    const refused = computeOf([sandbox('TERMINATED')]);
    refused.setMetadata.mockRejectedValue(new ComputeError(403, 'Required permission'));
    const warn = vi.fn();

    await sandboxesOf({ compute: raced, logger: { ...silentLogger, warn } }).suspend('box');
    await sandboxesOf({ compute: refused, logger: { ...silentLogger, warn } }).suspend('box');

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      'sbx-box keeps its agent token: ComputeError: Compute Engine: Required permission',
    );
  });

  it('waits for a machine told to stop to leave RUNNING, and gives up on one that stays', async () => {
    const compute = computeOf([sandbox('RUNNING'), sandbox('RUNNING'), sandbox('STOPPING')]);
    compute.stopInstance.mockResolvedValue();

    await sandboxesOf({ compute }).suspend('box');
    expect(compute.getInstance).toHaveBeenCalledTimes(3);

    const stuck = computeOf([sandbox('RUNNING')]);
    stuck.deleteInstance.mockResolvedValue();
    await expect(
      sandboxesOf({ compute: stuck, startTimeoutMs: -1 }).delete('box'),
    ).rejects.toMatchObject({ status: 504 });
  });

  it('makes the proxy forget the sandboxes whose machine no longer runs, and no other', async () => {
    const machine = (name: string, status: string, networkIP: string): Instance => ({
      ...sandbox(status),
      name,
      networkInterfaces: [{ networkIP }],
    });
    const compute = computeOf();
    compute.listInstances.mockResolvedValue([
      machine('sbx-running', 'RUNNING', '10.0.0.1'),
      machine('sbx-stopped', 'TERMINATED', '10.0.0.2'),
      machine('sbx-new', 'RUNNING', '10.0.0.4'),
      machine('other-box', 'RUNNING', '10.0.0.5'),
    ]);
    const proxy = proxyOf();
    proxy.list.mockResolvedValue([
      { name: 'running', address: '10.0.0.1', serial: 1, sent: 0, received: 0 },
      { name: 'stopped', address: '10.0.0.2', serial: 2, sent: 0, received: 0 },
      { name: 'deleted', address: '10.0.0.3', serial: 3, sent: 0, received: 0 },
      // Its address went to another sandbox of the service.
      { name: 'gone', address: '10.0.0.4', serial: 4, sent: 0, received: 0 },
      // A sandbox of another service sharing the proxy, its prefix another.
      { name: 'box', address: '10.0.0.5', serial: 5, sent: 0, received: 0 },
    ]);
    const info = vi.fn();

    const forgotten = await sandboxesOf({
      compute,
      proxy,
      logger: { ...silentLogger, info },
    }).reconcile();

    expect(forgotten).toEqual(['stopped', 'deleted', 'gone']);
    expect(proxy.remove.mock.calls).toEqual([
      ['stopped', 2],
      ['deleted', 3],
      ['gone', 4],
    ]);
    expect(info).toHaveBeenCalledWith(
      'The proxy forgot stopped, deleted, gone: their machines no longer run',
    );
    compute.listInstances.mockResolvedValue([]);
    proxy.list.mockResolvedValue([
      { name: 'last', address: '10.0.0.6', serial: 6, sent: 0, received: 0 },
    ]);
    await sandboxesOf({ compute, proxy, logger: { ...silentLogger, info } }).reconcile();
    expect(info).toHaveBeenLastCalledWith('The proxy forgot last: its machine no longer runs');
  });

  it('reconciles in the background of a creation, once per period, and never by default', async () => {
    agentAnswers(PROTOCOL_VERSION);
    const create = async (reconcileEveryMs?: number): Promise<Stub<ProxyAdmin>> => {
      const proxy = proxyOf();
      const sandboxes = sandboxesOf({
        compute: computeOf([undefined, sandbox('RUNNING')]),
        proxy,
        reconcileEveryMs,
      });
      await sandboxes.create('box', {});
      await sandboxes.resume('box', {});
      return proxy;
    };

    expect((await create(60_000)).list).toHaveBeenCalledTimes(1);
    expect((await create(0)).list).toHaveBeenCalledTimes(2);
    expect((await create()).list).not.toHaveBeenCalled();

    const failing = proxyOf();
    failing.list.mockRejectedValue(new Error('unreachable'));
    const warn = vi.fn();
    const sandboxes = sandboxesOf({
      compute: computeOf([undefined, sandbox('RUNNING')]),
      proxy: failing,
      reconcileEveryMs: 0,
      logger: { ...silentLogger, warn },
    });
    await sandboxes.create('box', {});
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        'The proxy could not be reconciled with the machines: Error: unreachable',
      ),
    );
  });

  it('deletes a machine without waiting for Compute Engine to be done, and nothing not its own', async () => {
    const compute = computeOf([sandbox('RUNNING'), undefined]);

    await sandboxesOf({ compute }).delete('box');
    expect(compute.deleteInstance).toHaveBeenCalledWith('sbx-box', { wait: false });

    const foreign = computeOf([{ ...sandbox('RUNNING'), labels: {} }]);
    await sandboxesOf({ compute: foreign }).delete('box');
    expect(foreign.deleteInstance).not.toHaveBeenCalled();
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

describe('the warm pool', () => {
  /**
   * A zone holding whole machines by name: listed by label, labelled with their fingerprint, made
   * running by an insert and stopped or gone as asked.
   */
  function zoneOf(initial: Instance[] = []): {
    compute: Stub<ComputeApi>;
    machines: Map<string, Instance>;
  } {
    const machines = new Map(initial.map((machine) => [machine.name, machine]));
    let fingerprints = 0;
    const compute = computeOf();
    compute.getInstance.mockImplementation((name: string) => Promise.resolve(machines.get(name)));
    compute.listInstances.mockImplementation((key: string, value: string) =>
      Promise.resolve([...machines.values()].filter(({ labels }) => labels?.[key] === value)),
    );
    compute.insertInstance.mockImplementation((body: Record<string, unknown>) => {
      const name = body['name'] as string;
      machines.set(name, {
        name,
        status: 'RUNNING',
        labels: body['labels'] as Record<string, string>,
        labelFingerprint: `l${++fingerprints}`,
        networkInterfaces: [{ networkIP: `10.0.1.${machines.size}` }],
        metadata: body['metadata'] as Instance['metadata'],
      });
      return Promise.resolve();
    });
    compute.setLabels.mockImplementation(
      (name: string, labels: Record<string, string>, fingerprint: string | undefined) => {
        const machine = machines.get(name);
        if (machine === undefined) return Promise.reject(new ComputeError(404, 'not found'));
        if (machine.labelFingerprint !== fingerprint) {
          return Promise.reject(new ComputeError(412, 'Labels fingerprint invalid'));
        }
        machines.set(name, { ...machine, labels, labelFingerprint: `l${++fingerprints}` });
        return Promise.resolve();
      },
    );
    compute.stopInstance.mockImplementation((name: string) => {
      const machine = machines.get(name);
      if (machine !== undefined) machines.set(name, { ...machine, status: 'TERMINATED' });
      return Promise.resolve();
    });
    compute.startInstance.mockImplementation((name: string) => {
      const machine = machines.get(name);
      if (machine !== undefined) machines.set(name, { ...machine, status: 'RUNNING' });
      return Promise.resolve();
    });
    compute.deleteInstance.mockImplementation((name: string) => {
      machines.delete(name);
      return Promise.resolve();
    });
    return { compute, machines };
  }

  /** The machines of the pool in `machines`. */
  const poolIn = (machines: Map<string, Instance>): Instance[] =>
    [...machines.values()].filter(({ labels }) => labels?.['ai-sdk-sandbox'] === 'pool');

  /** A machine of the pool of `template`, running unless told otherwise. */
  const poolMachine = (name: string, template: string, overrides: Partial<Instance> = {}) => ({
    name,
    status: 'RUNNING',
    labels: {
      'ai-sdk-sandbox': 'pool',
      'ai-sdk-sandbox-image': 'default',
      'ai-sdk-sandbox-template': template,
    },
    labelFingerprint: `${name}-l0`,
    networkInterfaces: [{ networkIP: '10.0.2.1' }],
    metadata: { items: [{ key: 'ai-sdk-sandbox-agent-run', value: 'r1' }] },
    ...overrides,
  });

  /** The time `hours` ago, as Compute Engine writes it. */
  const hoursAgo = (hours: number): string =>
    new Date(Date.now() - hours * 3_600_000).toISOString();

  /** The label the pool gives the template `deps` of the default image. */
  async function depsLabel(): Promise<string> {
    agentAnswers(PROTOCOL_VERSION);
    const { compute, machines } = zoneOf();
    await sandboxesOf({ compute, warmPool: 1 }).create('first', { template: 'deps' });
    return poolIn(machines)[0]?.labels?.['ai-sdk-sandbox-template'] ?? '';
  }

  it('makes a machine from the template beside a creation from it, and none without one', async () => {
    agentAnswers(PROTOCOL_VERSION);
    const { compute, machines } = zoneOf();
    const sandboxes = sandboxesOf({ compute, warmPool: 1 });

    await sandboxes.create('plain', {});
    expect(poolIn(machines)).toEqual([]);

    await sandboxes.create('box', { template: 'deps' });
    const [pooled] = poolIn(machines);
    expect(pooled?.name).toMatch(/^sbx-pool-[0-9a-f]{8}$/);
    expect(pooled?.labels).toEqual({
      'ai-sdk-sandbox': 'pool',
      'ai-sdk-sandbox-image': 'default',
      'ai-sdk-sandbox-template': expect.stringMatching(/^deps-[0-9a-f]{8}$/) as unknown,
    });
    expect(compute.insertInstance).toHaveBeenCalledWith(
      expect.objectContaining({
        name: pooled?.name,
        serviceAccounts: [],
        disks: [
          expect.objectContaining({
            initializeParams: expect.objectContaining({
              sourceImage: expect.stringMatching(/\/images\/deps-[0-9a-f]{8}$/) as unknown,
            }) as unknown,
          }),
        ],
      }),
      { wait: false },
    );
    expect(machines.has('sbx-box')).toBe(true);
  });

  it('gives a creation from the template a running machine of the pool, and makes the next', async () => {
    const deps = await depsLabel();
    agentAnswers(PROTOCOL_VERSION);
    const { compute, machines } = zoneOf([poolMachine('sbx-pool-a', deps)]);
    const proxy = proxyOf();
    const info = vi.fn();
    const sandboxes = sandboxesOf({
      compute,
      proxy,
      warmPool: 1,
      logger: { ...silentLogger, info },
    });

    await expect(sandboxes.create('box', { template: 'deps' })).resolves.toMatchObject({
      name: 'box',
    });

    expect(machines.has('sbx-box')).toBe(false);
    expect(machines.get('sbx-pool-a')?.labels).toMatchObject({
      'ai-sdk-sandbox': 'sandbox',
      'ai-sdk-sandbox-name': 'box',
    });
    expect(proxy.register).toHaveBeenCalledWith(
      'box',
      expect.objectContaining({ address: '10.0.2.1' }),
    );
    const [next] = poolIn(machines);
    expect(next?.name).toMatch(/^sbx-pool-/);
    expect(info).toHaveBeenCalledWith(
      expect.stringMatching(/^box created in \d+ ms on sbx-pool-a of the warm pool$/),
    );

    // The machine keeps its name: its agent's token is still the one of its machine.
    const agent = await sandboxesOf({ compute }).agent('box');
    expect(agent.endpoint.token).toBe(agentToken('a-secret', 'sbx-pool-a', 'r1'));
  });

  it('finds the sandbox of a machine of the pool by its label, to stop, start and delete it', async () => {
    agentAnswers(PROTOCOL_VERSION);
    const taken = poolMachine('sbx-pool-a', 'deps-x', {
      labels: { 'ai-sdk-sandbox': 'sandbox', 'ai-sdk-sandbox-name': 'box' },
    });
    const { compute, machines } = zoneOf([taken]);
    const sandboxes = sandboxesOf({ compute });

    await expect(sandboxes.create('box', {})).rejects.toMatchObject({ status: 409 });
    await sandboxes.suspend('box');
    expect(compute.stopInstance).toHaveBeenCalledWith('sbx-pool-a', { wait: false });
    expect(compute.setMetadata).toHaveBeenCalledWith('sbx-pool-a', expect.anything());

    await sandboxes.resume('box', {});
    expect(compute.startInstance).toHaveBeenCalledWith('sbx-pool-a');

    await sandboxes.delete('box');
    expect(machines.has('sbx-pool-a')).toBe(false);
    await expect(sandboxes.resume('box', {})).rejects.toMatchObject({ status: 404 });
  });

  it('never takes a machine named after a sandbox for another one', async () => {
    // Taken from the pool by `box`, its name is that of a sandbox `pool-a`.
    const taken = poolMachine('sbx-pool-a', 'deps-x', {
      labels: { 'ai-sdk-sandbox': 'sandbox', 'ai-sdk-sandbox-name': 'box' },
    });
    const { compute, machines } = zoneOf([taken]);
    const sandboxes = sandboxesOf({ compute });

    await expect(sandboxes.agent('pool-a')).rejects.toMatchObject({ status: 404 });
    await sandboxes.delete('pool-a');
    expect(machines.has('sbx-pool-a')).toBe(true);
  });

  it('keeps a pool per template, and deletes the machines stopped or waiting for over a day', async () => {
    const deps = await depsLabel();
    agentAnswers(PROTOCOL_VERSION);
    const dayAgo = hoursAgo(25);
    const { compute, machines } = zoneOf([
      poolMachine('sbx-pool-other', 'other-template'),
      poolMachine('sbx-pool-stopped', deps, { status: 'TERMINATED' }),
      poolMachine('sbx-pool-unused', 'other-template', { creationTimestamp: dayAgo }),
      poolMachine('sbx-pool-waited', deps, { creationTimestamp: dayAgo }),
      // Another service's pool, under its own prefix.
      poolMachine('dev-pool-a', 'other-template', { creationTimestamp: dayAgo }),
    ]);
    const sandboxes = sandboxesOf({ compute, warmPool: 1 });

    await sandboxes.create('box', { template: 'deps' });

    expect(machines.has('sbx-box')).toBe(true);
    expect([...machines.keys()].filter((name) => name.includes('pool'))).toEqual([
      'sbx-pool-other',
      'dev-pool-a',
      expect.stringMatching(/^sbx-pool-[0-9a-f]{8}$/),
    ]);
    // Labelled first, so that no creation takes it meanwhile.
    expect(compute.setLabels).toHaveBeenCalledWith(
      'sbx-pool-unused',
      expect.objectContaining({ 'ai-sdk-sandbox-retired': 'true' }),
      'sbx-pool-unused-l0',
    );
  });

  it('takes a machine still booting rather than boot one, a running one first', async () => {
    const deps = await depsLabel();
    agentAnswers(PROTOCOL_VERSION);
    const { compute, machines } = zoneOf([
      poolMachine('sbx-pool-booting', deps, {
        status: 'STAGING',
        creationTimestamp: hoursAgo(2),
      }),
      poolMachine('sbx-pool-running', deps, { creationTimestamp: hoursAgo(1) }),
    ]);
    // Compute Engine says the booting machine runs once read again.
    const get = compute.getInstance.getMockImplementation();
    let reads = 0;
    compute.getInstance.mockImplementation((name: string) => {
      const machine = machines.get(name);
      if (name === 'sbx-pool-booting' && machine !== undefined && ++reads > 1) {
        machines.set(name, { ...machine, status: 'RUNNING' });
      }
      return get?.(name) ?? Promise.resolve(undefined);
    });
    const sandboxes = sandboxesOf({ compute, warmPool: 1 });

    await sandboxes.create('one', { template: 'deps' });
    expect(machines.get('sbx-pool-running')?.labels?.['ai-sdk-sandbox-name']).toBe('one');

    await sandboxes.create('two', { template: 'deps' });
    expect(machines.get('sbx-pool-booting')?.labels?.['ai-sdk-sandbox-name']).toBe('two');
    expect(machines.get('sbx-pool-booting')?.status).toBe('RUNNING');
    expect(machines.has('sbx-one')).toBe(false);
    expect(machines.has('sbx-two')).toBe(false);
  });

  it('deletes a machine taken while booting that never boots', async () => {
    const deps = await depsLabel();
    agentAnswers(PROTOCOL_VERSION);
    const { compute, machines } = zoneOf([
      poolMachine('sbx-pool-stuck', deps, { status: 'STAGING' }),
    ]);

    await expect(
      sandboxesOf({ compute, startTimeoutMs: -1 }).create('box', { template: 'deps' }),
    ).rejects.toMatchObject({ status: 503 });
    expect(machines.has('sbx-pool-stuck')).toBe(false);
  });

  it('keeps no more machines than asked, and takes the last ones once none is', async () => {
    const deps = await depsLabel();
    agentAnswers(PROTOCOL_VERSION);
    const { compute, machines } = zoneOf([
      poolMachine('sbx-pool-a', deps, { creationTimestamp: hoursAgo(2) }),
      poolMachine('sbx-pool-b', deps, { creationTimestamp: hoursAgo(1) }),
    ]);

    await sandboxesOf({ compute, warmPool: 0 }).create('box', { template: 'deps' });

    expect(machines.get('sbx-pool-a')?.labels?.['ai-sdk-sandbox-name']).toBe('box');
    expect(poolIn(machines)).toEqual([]);
    expect(compute.insertInstance).not.toHaveBeenCalled();
  });

  it('makes a machine of its own when another creation took the one of the pool first, which refills it', async () => {
    const deps = await depsLabel();
    agentAnswers(PROTOCOL_VERSION);
    const { compute, machines } = zoneOf([poolMachine('sbx-pool-a', deps)]);
    // Taken by another creation between the list and the change of its labels.
    compute.setLabels.mockRejectedValueOnce(new ComputeError(412, 'Labels fingerprint invalid'));

    await sandboxesOf({ compute, warmPool: 1 }).create('box', { template: 'deps' });

    expect(machines.get('sbx-box')?.status).toBe('RUNNING');
    expect(machines.get('sbx-pool-a')?.labels?.['ai-sdk-sandbox']).toBe('pool');
    // Nothing added: the creation that took the machine makes the next one.
    expect(poolIn(machines)).toHaveLength(1);
  });

  it('leaves the pool alone when Compute Engine refuses to label its machines', async () => {
    const deps = await depsLabel();
    agentAnswers(PROTOCOL_VERSION);
    const { compute, machines } = zoneOf([poolMachine('sbx-pool-a', deps)]);
    compute.setLabels.mockRejectedValue(new ComputeError(403, 'Required permission'));
    const warn = vi.fn();

    await sandboxesOf({ compute, warmPool: 1, logger: { ...silentLogger, warn } }).create('box', {
      template: 'deps',
    });

    expect(machines.has('sbx-box')).toBe(true);
    expect(poolIn(machines).map(({ name }) => name)).toEqual(['sbx-pool-a']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('The warm pool is left alone'));
  });

  it('gives a name to one machine only, when two creations of it race', async () => {
    agentAnswers(PROTOCOL_VERSION);
    const { compute, machines } = zoneOf();
    const insert = compute.insertInstance.getMockImplementation();
    compute.insertInstance.mockImplementation(async (body: Record<string, unknown>) => {
      await insert?.(body);
      // Meanwhile, another creation of `box` took a machine of the pool.
      machines.set(
        'sbx-pool-z',
        poolMachine('sbx-pool-z', 'deps-x', {
          labels: { 'ai-sdk-sandbox': 'sandbox', 'ai-sdk-sandbox-name': 'box' },
        }),
      );
    });

    await expect(sandboxesOf({ compute }).create('box', {})).rejects.toMatchObject({
      status: 409,
    });
    expect(machines.has('sbx-box')).toBe(false);
    expect(machines.has('sbx-pool-z')).toBe(true);
  });

  it('counts its machines neither as running sandboxes nor as keeping the proxy up', async () => {
    agentAnswers(PROTOCOL_VERSION);
    const { compute } = zoneOf([
      poolMachine('sbx-pool-a', 'deps-x'),
      poolMachine('sandbox-proxy', 'none', { labels: {} }),
    ]);
    const sandboxes = sandboxesOf({ compute, maxRunning: 1, proxyInstance: 'sandbox-proxy' });

    await sandboxes.create('box', {});
    await sandboxes.delete('box');

    expect(compute.stopInstance).toHaveBeenCalledWith('sandbox-proxy', { wait: false });
  });

  it('keeps the proxy running when told to, once no sandbox runs', async () => {
    agentAnswers(PROTOCOL_VERSION);
    const { compute } = zoneOf([poolMachine('sandbox-proxy', 'none', { labels: {} })]);
    const sandboxes = sandboxesOf({
      compute,
      proxyInstance: 'sandbox-proxy',
      proxyAlwaysOn: true,
    });

    await sandboxes.create('box', {});
    await sandboxes.delete('box');

    expect(compute.stopInstance).not.toHaveBeenCalled();
  });

  it('keeps in the proxy a sandbox on a machine taken from the pool', async () => {
    const { compute } = zoneOf([
      poolMachine('sbx-pool-a', 'deps-x', {
        labels: { 'ai-sdk-sandbox': 'sandbox', 'ai-sdk-sandbox-name': 'box' },
      }),
    ]);
    const proxy = proxyOf();
    proxy.list.mockResolvedValue([
      { name: 'box', address: '10.0.2.1', serial: 1, sent: 0, received: 0 },
      { name: 'pool-a', address: '10.0.2.1', serial: 2, sent: 0, received: 0 },
    ]);

    await expect(sandboxesOf({ compute, proxy }).reconcile()).resolves.toEqual(['pool-a']);
  });
});
