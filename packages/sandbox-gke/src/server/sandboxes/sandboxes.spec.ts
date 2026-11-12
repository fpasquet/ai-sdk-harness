import type { Mock } from 'vitest';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  Condition,
  KubernetesApi,
  SandboxResource,
  VolumeSnapshotResource,
} from '../kubernetes/kubernetes-api.js';
import type { ProxyAdmin } from './proxy-admin.js';
import type { PodSettings, SandboxesOptions } from './sandboxes.js';

import { silentLogger } from '../../common/logger.js';
import { PROTOCOL_VERSION } from '../../protocol/version.js';
import { KubernetesError } from '../kubernetes/kubernetes-error.js';
import { AgentClient } from './agent-client.js';
import { Sandboxes } from './sandboxes.js';

// The waits between two polls of a pod, an agent or a snapshot pass at once.
vi.mock('node:timers/promises', () => ({ setTimeout: () => Promise.resolve() }));

afterEach(() => vi.restoreAllMocks());

/** Each method of `T` as a mock, its calls for the tests to check. */
type Stub<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R ? Mock<(...args: A) => R> : T[K];
};

const condition = (type: string, status: Condition['status'], reason?: string): Condition => ({
  type,
  status,
  ...(reason === undefined ? {} : { reason, message: `${type} is ${status}` }),
});

/** The `Sandbox` resource of `sbx-box`, in `mode`, with its pod's `conditions`. */
function sandbox(
  conditions: Condition[] = [],
  { mode = 'Running', podIPs = ['10.4.0.7'], labels = {}, deleting = false } = {},
): SandboxResource {
  return {
    metadata: {
      name: 'sbx-box',
      labels: { 'ai-sdk-sandbox': 'sandbox', ...labels },
      ...(deleting ? { deletionTimestamp: '2026-10-27T08:00:00Z' } : {}),
    },
    spec: { operatingMode: mode as 'Running' | 'Suspended' },
    status: { conditions, podIPs },
  };
}

const ready = (options = {}) => sandbox([condition('Ready', 'True')], options);

/** A Kubernetes whose sandbox `sbx-box` goes through `states`, the last one kept. */
function kubernetesOf(
  states: (SandboxResource | undefined)[] = [],
  snapshots: (undefined | VolumeSnapshotResource)[] = [],
): Stub<KubernetesApi> {
  return {
    getSandbox: vi.fn(() => Promise.resolve(states.length > 1 ? states.shift() : states[0])),
    createSandbox: vi.fn(() => Promise.resolve()),
    patchSandbox: vi.fn(() => Promise.resolve()),
    deleteSandbox: vi.fn(() => Promise.resolve()),
    getSnapshot: vi.fn(() =>
      Promise.resolve(snapshots.length > 1 ? snapshots.shift() : snapshots[0]),
    ),
    createSnapshot: vi.fn(() => Promise.resolve()),
    deleteSnapshot: vi.fn(() => Promise.resolve()),
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

const pod: PodSettings = {
  images: { default: 'europe-docker.pkg.dev/p/sandboxes/default@sha256:abc' },
  cpu: '2',
  memory: '4Gi',
  ephemeralStorage: '10Gi',
  volumeSize: '20Gi',
  uid: 1000,
  home: '/home/agent',
};

function sandboxesOf({
  kubernetes = kubernetesOf(),
  proxy = proxyOf(),
  ...overrides
}: Partial<Omit<SandboxesOptions, 'kubernetes' | 'proxy'>> & {
  kubernetes?: Stub<KubernetesApi>;
  proxy?: Stub<ProxyAdmin>;
} = {}): Sandboxes {
  return new Sandboxes({
    kubernetes: kubernetes as unknown as KubernetesApi,
    proxy: proxy as unknown as ProxyAdmin,
    logger: silentLogger,
    pod,
    namePrefix: 'sbx-',
    agentSecret: 'a-secret',
    agentPort: 8100,
    proxyUrl: () => Promise.resolve('http://10.4.0.2:3128'),
    network: { allowedHosts: ['registry.npmjs.org'], baseUrls: {} },
    startTimeoutMs: 15_000,
    snapshotTimeoutMs: 15_000,
    ...overrides,
  });
}

/** An agent that answers at once, in `protocol`. */
function agentAnswers(protocol: number | undefined): void {
  vi.spyOn(AgentClient.prototype, 'health').mockResolvedValue(protocol);
  vi.spyOn(AgentClient.prototype, 'configure').mockResolvedValue({
    home: '/home/agent',
    workingDirectory: '/home/agent/workspace',
  });
}

describe('the sandboxes of the GKE service', () => {
  it('needs a default image and a short name prefix', () => {
    expect(() => sandboxesOf({ pod: { ...pod, images: {} } })).toThrow('need a "default" image');
    expect(() => sandboxesOf({ namePrefix: 'Too-long-prefix' })).toThrow('name prefix');
  });

  it('finds no agent for a sandbox whose pod is not ready, and remembers a ready one', async () => {
    await expect(
      sandboxesOf({ kubernetes: kubernetesOf([sandbox()]) }).agent('box'),
    ).rejects.toMatchObject({ status: 404 });

    const kubernetes = kubernetesOf([ready()]);
    const sandboxes = sandboxesOf({ kubernetes });
    const agent = await sandboxes.agent('box');
    await sandboxes.agent('box');

    expect(agent.endpoint).toMatchObject({ host: '10.4.0.7', port: 8100 });
    expect(kubernetes.getSandbox).toHaveBeenCalledTimes(1);
  });

  it('creates a sandbox on its image, registers it with the proxy and configures its agent', async () => {
    agentAnswers(PROTOCOL_VERSION);
    const kubernetes = kubernetesOf([undefined, sandbox(), ready()]);
    const proxy = proxyOf();
    const sandboxes = sandboxesOf({
      kubernetes,
      proxy,
      pod: { ...pod, storageClassName: 'premium-rwo', runtimeClassName: 'gvisor' },
    });

    await expect(sandboxes.create('box', { allowedHosts: ['github.com'] })).resolves.toEqual({
      name: 'box',
      home: '/home/agent',
      workingDirectory: '/home/agent/workspace',
    });

    const [body] = kubernetes.createSandbox.mock.calls[0] ?? [];
    expect(JSON.stringify(body)).toContain('"storageClassName":"premium-rwo"');
    expect(JSON.stringify(body)).toContain('"runtimeClassName":"gvisor"');
    expect(proxy.register).toHaveBeenCalledWith('box', {
      address: '10.4.0.7',
      allowedHosts: ['registry.npmjs.org', 'github.com'],
      baseUrls: {},
    });
  });

  it('starts a sandbox from a template made on its image, and refuses a missing one', async () => {
    agentAnswers(PROTOCOL_VERSION);
    const kubernetes = kubernetesOf(
      [undefined, ready()],
      [{ metadata: { name: 'deps' }, status: { readyToUse: true } }],
    );

    await sandboxesOf({ kubernetes }).create('box', { template: 'deps' });

    const [body] = kubernetes.createSandbox.mock.calls[0] ?? [];
    expect(JSON.stringify(body)).toMatch(/"kind":"VolumeSnapshot","name":"deps-[0-9a-f]{8}"/);

    const pending = kubernetesOf(
      [undefined],
      [{ metadata: { name: 'deps' }, status: { readyToUse: false } }],
    );
    await expect(
      sandboxesOf({ kubernetes: pending }).create('box', { template: 'deps' }),
    ).rejects.toThrow('No template "deps" on the image "default".');
  });

  it('refuses a name taken, before or meanwhile, an image not offered and an invalid name', async () => {
    await expect(
      sandboxesOf({ kubernetes: kubernetesOf([ready()]) }).create('box', {}),
    ).rejects.toMatchObject({ status: 409 });

    const raced = kubernetesOf([undefined]);
    raced.createSandbox.mockRejectedValueOnce(new KubernetesError(409, 'exists'));
    await expect(sandboxesOf({ kubernetes: raced }).create('box', {})).rejects.toMatchObject({
      status: 409,
    });

    const refused = kubernetesOf([undefined]);
    refused.createSandbox.mockRejectedValueOnce(new KubernetesError(403, 'forbidden'));
    await expect(sandboxesOf({ kubernetes: refused }).create('box', {})).rejects.toMatchObject({
      status: 403,
    });

    await expect(sandboxesOf().create('box', { image: 'python' })).rejects.toThrow(
      'No image "python" on this service. It offers: default.',
    );
    await expect(sandboxesOf().create('Not_Valid', {})).rejects.toMatchObject({ status: 400 });
  });

  it('deletes a sandbox whose pod stopped, was deleted or never got ready', async () => {
    const finished = kubernetesOf([
      undefined,
      sandbox([condition('Finished', 'True'), condition('Ready', 'False', 'PodFailed')]),
    ]);
    await expect(sandboxesOf({ kubernetes: finished }).create('box', {})).rejects.toThrow(
      'The pod of "box" stopped: PodFailed: Ready is False.',
    );
    expect(finished.deleteSandbox).toHaveBeenCalledWith('sbx-box');

    const deleted = kubernetesOf([undefined, ready({ deleting: true })]);
    await expect(sandboxesOf({ kubernetes: deleted }).create('box', {})).rejects.toMatchObject({
      status: 404,
    });

    const unscheduled = kubernetesOf([
      undefined,
      sandbox([condition('PodScheduled', 'False', 'Unschedulable')]),
    ]);
    await expect(
      sandboxesOf({ kubernetes: unscheduled, startTimeoutMs: -1 }).create('box', {}),
    ).rejects.toThrow('(Unschedulable: PodScheduled is False)');

    const silent = kubernetesOf([undefined, sandbox([])]);
    await expect(
      sandboxesOf({ kubernetes: silent, startTimeoutMs: -1 }).create('box', {}),
    ).rejects.toThrow('(no status yet)');
  });

  it('refuses an agent of another protocol, and one that does not answer', async () => {
    agentAnswers(PROTOCOL_VERSION + 1);
    await expect(
      sandboxesOf({ kubernetes: kubernetesOf([undefined, ready()]) }).create('box', {}),
    ).rejects.toMatchObject({ status: 502 });

    agentAnswers(undefined);
    await expect(
      sandboxesOf({
        kubernetes: kubernetesOf([undefined, ready()]),
        startTimeoutMs: 0,
      }).create('box', {}),
    ).rejects.toMatchObject({ status: 504 });
  });

  it('resumes a suspended sandbox, leaves a running one, and cannot resume one that is gone', async () => {
    agentAnswers(PROTOCOL_VERSION);
    const suspended = kubernetesOf([sandbox([], { mode: 'Suspended' }), ready()]);
    await sandboxesOf({ kubernetes: suspended }).resume('box', {});
    expect(suspended.patchSandbox).toHaveBeenCalledWith('sbx-box', {
      spec: { operatingMode: 'Running' },
    });

    const running = kubernetesOf([ready()]);
    await sandboxesOf({ kubernetes: running }).resume('box', {});
    expect(running.patchSandbox).not.toHaveBeenCalled();

    await expect(sandboxesOf().resume('box', {})).rejects.toMatchObject({ status: 404 });
    await expect(
      sandboxesOf({
        kubernetes: kubernetesOf([{ ...ready(), metadata: { name: 'sbx-box', labels: {} } }]),
      }).resume('box', {}),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('suspends a running sandbox once, nothing that is gone, and deletes one', async () => {
    const kubernetes = kubernetesOf([undefined, ready(), sandbox([], { mode: 'Suspended' })]);
    const proxy = proxyOf();
    proxy.remove.mockRejectedValue(new Error('unreachable'));
    const warn = vi.fn();
    const sandboxes = sandboxesOf({ kubernetes, proxy, logger: { ...silentLogger, warn } });

    await sandboxes.suspend('box');
    await sandboxes.suspend('box');
    await sandboxes.suspend('box');
    await sandboxes.delete('box');

    expect(kubernetes.patchSandbox).toHaveBeenCalledTimes(1);
    expect(kubernetes.patchSandbox).toHaveBeenCalledWith('sbx-box', {
      spec: { operatingMode: 'Suspended' },
    });
    expect(kubernetes.deleteSandbox).toHaveBeenCalledWith('sbx-box');
    expect(warn).toHaveBeenCalledWith('The proxy could not forget box: Error: unreachable');
  });

  it('passes on what a sandbox may reach and its credentials to the proxy', async () => {
    const proxy = proxyOf();
    const sandboxes = sandboxesOf({ proxy });
    const transformation = { match: { host: 'api.example.com' }, transform: { headers: {} } };

    await sandboxes.setAllowedHosts('box', ['github.com']);
    await sandboxes.addTransformations('box', [transformation]);
    await sandboxes.setTransformations('box', []);
    await sandboxes.assertNoSecret('box', ['echo hello']);
    proxy.holdsSecret.mockResolvedValue(true);

    expect(proxy.setAllowedHosts).toHaveBeenCalledWith('box', ['registry.npmjs.org', 'github.com']);
    expect(proxy.addTransformations).toHaveBeenCalledWith('box', [transformation]);
    expect(proxy.setTransformations).toHaveBeenCalledWith('box', []);
    await expect(sandboxes.assertNoSecret('box', ['echo secret'])).rejects.toMatchObject({
      status: 400,
    });
  });

  it('saves a template from the volume of a suspended sandbox, a concurrent save as good', async () => {
    const kubernetes = kubernetesOf(
      [
        ready({ labels: { 'ai-sdk-sandbox-image': 'default' } }),
        ready(),
        sandbox([condition('Suspended', 'True')], { mode: 'Suspended' }),
      ],
      [
        { metadata: { name: 'deps' }, status: { readyToUse: false } },
        { metadata: { name: 'deps' }, status: { readyToUse: true } },
      ],
    );
    kubernetes.createSnapshot.mockRejectedValueOnce(new KubernetesError(409, 'exists'));

    await sandboxesOf({
      kubernetes,
      pod: { ...pod, snapshotClassName: 'pd-snapshots' },
    }).saveTemplate('box', 'deps');

    const [body] = kubernetes.createSnapshot.mock.calls[0] ?? [];
    expect(body).toMatchObject({
      metadata: { name: expect.stringMatching(/^deps-[0-9a-f]{8}$/) as unknown },
      spec: {
        volumeSnapshotClassName: 'pd-snapshots',
        source: { persistentVolumeClaimName: 'home-sbx-box' },
      },
    });
  });

  it('says when a template cannot be saved', async () => {
    await expect(sandboxesOf().saveTemplate('box', 'deps')).rejects.toMatchObject({ status: 404 });

    const refused = kubernetesOf([ready(), sandbox([condition('Suspended', 'True')])]);
    refused.createSnapshot.mockRejectedValueOnce(new KubernetesError(403, 'forbidden'));
    await expect(
      sandboxesOf({ kubernetes: refused }).saveTemplate('box', 'deps'),
    ).rejects.toMatchObject({ status: 403 });

    const failed = kubernetesOf(
      [ready(), sandbox([condition('Suspended', 'True')])],
      [{ metadata: { name: 'deps' }, status: { error: { message: 'quota exceeded' } } }],
    );
    await expect(sandboxesOf({ kubernetes: failed }).saveTemplate('box', 'deps')).rejects.toThrow(
      'failed: quota exceeded',
    );

    const slow = kubernetesOf([ready(), sandbox([condition('Suspended', 'True')])]);
    await expect(
      sandboxesOf({ kubernetes: slow, snapshotTimeoutMs: -1 }).saveTemplate('box', 'deps'),
    ).rejects.toMatchObject({ status: 504 });

    const stuck = kubernetesOf([ready()]);
    await expect(
      sandboxesOf({ kubernetes: stuck, startTimeoutMs: -1 }).saveTemplate('box', 'deps'),
    ).rejects.toThrow('did not stop');
  });

  it('tells whether a template exists, deletes one, and refuses an invalid id', async () => {
    const kubernetes = kubernetesOf(
      [],
      [{ metadata: { name: 'deps' }, status: { readyToUse: true } }],
    );
    const sandboxes = sandboxesOf({ kubernetes });

    await expect(sandboxes.templateExists('deps')).resolves.toBe(true);
    await sandboxes.deleteTemplate('deps');

    expect(kubernetes.deleteSnapshot).toHaveBeenCalledWith(
      expect.stringMatching(/^deps-[0-9a-f]{8}$/),
    );
    await expect(sandboxes.deleteTemplate('Not_Valid')).rejects.toMatchObject({ status: 400 });
  });
});
