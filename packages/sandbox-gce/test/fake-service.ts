import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SandboxNetwork } from '../src/protocol/api.js';
import type { SandboxServer } from '../src/server/http/sandbox-server.js';
import type { FakeCompute } from './fake-compute.js';

import { silentLogger } from '../src/common/logger.js';
import { createAdminServer } from '../src/proxy/admin-server.js';
import { EgressProxy } from '../src/proxy/egress-proxy.js';
import { SandboxRegistry } from '../src/proxy/registry.js';
import { AccessToken } from '../src/server/compute/access-token.js';
import { ComputeApi } from '../src/server/compute/compute-api.js';
import { createSandboxServer } from '../src/server/http/sandbox-server.js';
import { ProxyAdmin } from '../src/server/sandboxes/proxy-admin.js';
import { startFakeCompute } from './fake-compute.js';

const PROXY_TOKEN = 'proxy-token-for-the-tests';

/** The service, its egress proxy and a fake Compute Engine, all on the loopback. */
export interface FakeService {
  /** Where the service listens. */
  url: string;
  service: SandboxServer;
  compute: FakeCompute;
  registry: SandboxRegistry;
  /** The egress proxy, as the sandboxes reach it. */
  proxyUrl: string;
  /** The instance name of the sandbox `name`. */
  instanceOf(name: string): string;
  dispose(): Promise<void>;
}

/** What a test changes of the service and its proxy. */
interface FakeServiceOverrides {
  allowPrivateNetwork?: boolean;
  network?: Required<SandboxNetwork>;
  serviceToken?: string;
  /** The port the proxy's tunnels reach, 443 without it. */
  tunnelPort?: number;
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

/**
 * Starts the service over a fake Compute Engine, with a real egress proxy that lets the sandboxes
 * reach the loopback, in plain HTTP: the tests' upstreams listen there. Every machine is on
 * 127.0.0.1, so the proxy tells the sandboxes apart by the last one registered: one sandbox per
 * test of the network.
 */
export async function startFakeService(overrides: FakeServiceOverrides = {}): Promise<FakeService> {
  const root = mkdtempSync(join(tmpdir(), 'gce-sandbox-'));
  const compute = await startFakeCompute(root);
  const registry = new SandboxRegistry(overrides.allowPrivateNetwork ?? true);
  const proxy = new EgressProxy(
    (address) => registry.policyFor(address),
    silentLogger,
    overrides.tunnelPort,
  );
  const proxyPort = await listen(proxy.server);
  const admin = createAdminServer({ registry, token: PROXY_TOKEN, logger: silentLogger });
  const adminPort = await listen(admin);
  const prefix = 'sbx-';
  const service = createSandboxServer({
    compute: new ComputeApi({
      endpoint: compute.endpoint,
      project: compute.project,
      zone: compute.zone,
      token: new AccessToken('none'),
    }),
    proxy: new ProxyAdmin(`http://127.0.0.1:${adminPort}`, PROXY_TOKEN),
    logger: silentLogger,
    zone: compute.zone,
    machine: {
      machineType: 'e2-standard-4',
      images: { default: compute.image, python: compute.pythonImage },
      diskSizeGb: 20,
      diskType: 'pd-balanced',
      tags: ['ai-sdk-sandbox'],
      spot: false,
    },
    instancePrefix: prefix,
    agentSecret: 'a-secret-of-thirty-two-characters!',
    agentPort: 8100,
    agentAddress: (instance) => ({ host: '127.0.0.1', port: compute.agentPort(instance.name) }),
    proxyUrl: `http://127.0.0.1:${proxyPort}`,
    network: overrides.network ?? { allowedHosts: [], baseUrls: {} },
    startTimeoutMs: 15_000,
    serviceToken: overrides.serviceToken,
  });
  const port = await listen(service.server);
  return {
    url: `http://127.0.0.1:${port}`,
    service,
    compute,
    registry,
    proxyUrl: `http://127.0.0.1:${proxyPort}`,
    instanceOf: (name) => `${prefix}${name}`,
    dispose: async () => {
      await service.close();
      await compute.dispose();
      proxy.close();
      admin.closeAllConnections();
      await new Promise((resolve) => admin.close(resolve));
      rmSync(root, { recursive: true, force: true });
    },
  };
}
