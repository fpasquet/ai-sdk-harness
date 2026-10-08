import type { AddressInfo } from 'node:net';

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { SandboxServer } from '../src/server/http/sandbox-server.js';
import type { ServiceOptions } from '../src/server/http/sandbox-server.js';

import { createSandboxServer } from '../src/server/http/sandbox-server.js';
import { silentLogger } from '../src/server/logger.js';
import { SandboxCli } from '../src/server/runtime/sandbox-cli.js';
import { DirectorySnapshotStore } from '../src/server/snapshots/directory-snapshot-store.js';
import { TEST_BUILD } from './build-helpers.js';

/** Path of the fake `sandbox` CLI. */
export const FAKE_SANDBOX = fileURLToPath(new URL('./fake-sandbox.mjs', import.meta.url));

/** The service, listening on the loopback over the fake CLI, with no isolation at all. */
export interface FakeService {
  /** Where it listens. */
  url: string;
  service: SandboxServer;
  /** Where a sandbox's files live: `{sandbox}` is its name. */
  files: string;
  /** Where the snapshots and templates are kept. */
  snapshots: string;
  /** Every call to the CLI so far. */
  calls(): string[][];
  dispose(): Promise<void>;
}

/** Starts the service over the fake CLI, `overrides` on top of the test settings. */
export async function startFakeService(
  overrides: Partial<
    Pick<ServiceOptions, 'layerTransfer' | 'network' | 'serviceToken' | 'store'> & {
      allowPrivateNetwork: boolean;
    }
  > = {},
): Promise<FakeService> {
  const root = mkdtempSync(join(tmpdir(), 'cloud-run-sandbox-'));
  const state = join(root, 'state');
  const files = join(root, '{sandbox}');
  const snapshots = join(root, 'snapshots');
  process.env['FAKE_SANDBOX_STATE'] = state;
  process.env['FAKE_SANDBOX_FILES'] = files;
  const service = createSandboxServer({
    cli: new SandboxCli(FAKE_SANDBOX),
    store: overrides.store ?? new DirectorySnapshotStore(snapshots),
    logger: silentLogger,
    sandbox: {
      node: process.execPath,
      helpers: join(TEST_BUILD, 'in-sandbox'),
      path: process.env['PATH'] ?? '/usr/bin:/bin',
      home: join(files, 'home'),
      workingDirectory: join(files, 'workspace'),
      // The fake sandboxes share this machine's loopback: each relay takes a free port.
      egressPort: 0,
      // The tests' upstreams listen on this machine's loopback, in plain HTTP.
      allowPrivateNetwork: overrides.allowPrivateNetwork ?? true,
    },
    network: overrides.network ?? { allowedHosts: [], baseUrls: {} },
    scratch: root,
    templateNamespace: 'test',
    layerTransfer: overrides.layerTransfer,
    serviceToken: overrides.serviceToken,
  });
  await new Promise<void>((resolve) => service.server.listen(0, '127.0.0.1', resolve));
  const { port } = service.server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    service,
    files,
    snapshots,
    calls: () =>
      readFileSync(join(state, 'calls.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as string[]),
    dispose: async () => {
      await service.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
