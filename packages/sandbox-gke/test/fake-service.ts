import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SandboxNetwork } from '../src/protocol/api.js';
import type { SandboxServer } from '../src/server/http/sandbox-server.js';
import type { PodSettings } from '../src/server/sandboxes/sandboxes.js';
import type { FakeKubernetes } from './fake-kubernetes.js';

import { silentLogger } from '../src/common/logger.js';
import { createAdminServer } from '../src/proxy/admin-server.js';
import { EgressProxy } from '../src/proxy/egress-proxy.js';
import { SandboxRegistry } from '../src/proxy/registry.js';
import { createSandboxServer } from '../src/server/http/sandbox-server.js';
import { KubernetesCredentials } from '../src/server/kubernetes/credentials.js';
import { KubernetesApi } from '../src/server/kubernetes/kubernetes-api.js';
import { ProxyAdmin } from '../src/server/sandboxes/proxy-admin.js';
import { startFakeKubernetes } from './fake-kubernetes.js';

const PROXY_TOKEN = 'proxy-token-for-the-tests';

/** The service token of the tests' services. */
export const SERVICE_TOKEN = 'a-service-token-of-thirty-two-chars!';

/** The images the tests' services offer. */
export const IMAGES = {
  default: 'europe-docker.pkg.dev/test/sandboxes/default:1',
  python: 'europe-docker.pkg.dev/test/sandboxes/python:1',
};

/** What the tests' sandboxes' pods are made of. */
const POD: PodSettings = {
  images: IMAGES,
  runtimeClassName: 'gvisor',
  cpu: '2',
  memory: '4Gi',
  ephemeralStorage: '10Gi',
  volumeSize: '20Gi',
  uid: 1000,
  home: '/home/agent',
};

/** The service, its egress proxy and a fake Kubernetes, all on the loopback. */
export interface FakeService {
  /** Where the service listens. */
  url: string;
  service: SandboxServer;
  kubernetes: FakeKubernetes;
  registry: SandboxRegistry;
  /** The egress proxy, as the sandboxes reach it. */
  proxyUrl: string;
  /** The resource name of the sandbox `name`. */
  resourceOf(name: string): string;
  dispose(): Promise<void>;
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

/**
 * Starts the service over a fake Kubernetes, with a real egress proxy that lets the sandboxes
 * reach the loopback, in plain HTTP: the tests' upstreams listen there. Every pod is on
 * 127.0.0.1, so the proxy tells the sandboxes apart by the last one registered: one sandbox per
 * test of the network.
 */
export async function startFakeService(
  overrides: {
    allowPrivateNetwork?: boolean;
    network?: Required<SandboxNetwork>;
    serviceToken?: string;
  } = {},
): Promise<FakeService> {
  const root = mkdtempSync(join(tmpdir(), 'gke-sandbox-'));
  const kubernetes = await startFakeKubernetes(root);
  const registry = new SandboxRegistry(overrides.allowPrivateNetwork ?? true);
  const proxy = new EgressProxy((address) => registry.policyFor(address));
  const proxyPort = await listen(proxy.server);
  const admin = createAdminServer({ registry, token: PROXY_TOKEN, logger: silentLogger });
  const adminPort = await listen(admin);
  const prefix = 'sbx-';
  const service = createSandboxServer({
    kubernetes: new KubernetesApi({
      endpoint: kubernetes.endpoint,
      namespace: kubernetes.namespace,
      credentials: new KubernetesCredentials('none'),
    }),
    proxy: new ProxyAdmin(`http://127.0.0.1:${adminPort}`, PROXY_TOKEN),
    logger: silentLogger,
    pod: POD,
    namePrefix: prefix,
    agentSecret: 'a-secret-of-thirty-two-characters!',
    agentPort: 8100,
    agentAddress: (sandbox) => ({
      host: '127.0.0.1',
      port: kubernetes.agentPort(sandbox.metadata.name),
    }),
    proxyUrl: () => Promise.resolve(`http://127.0.0.1:${proxyPort}`),
    network: overrides.network ?? { allowedHosts: [], baseUrls: {} },
    startTimeoutMs: 15_000,
    snapshotTimeoutMs: 15_000,
    serviceToken: overrides.serviceToken ?? SERVICE_TOKEN,
  });
  const port = await listen(service.server);
  return {
    url: `http://127.0.0.1:${port}`,
    service,
    kubernetes,
    registry,
    proxyUrl: `http://127.0.0.1:${proxyPort}`,
    resourceOf: (name) => `${prefix}${name}`,
    dispose: async () => {
      await service.close();
      await kubernetes.dispose();
      proxy.close();
      admin.closeAllConnections();
      await new Promise((resolve) => admin.close(resolve));
      rmSync(root, { recursive: true, force: true });
    },
  };
}
