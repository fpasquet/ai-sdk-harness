import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';

import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SrtManager } from '../src/client/transport/srt-runtime.js';

import { SandboxNetwork } from '../src/client/network/sandbox-network.js';
import { SrtNetworkSandboxSession } from '../src/client/session/srt-network-sandbox-session.js';
import { SupervisorHost } from '../src/client/session/supervisor-host.js';
import { SrtRuntime } from '../src/client/transport/srt-runtime.js';
import { TEST_BUILD } from './build-helpers.js';

/** A credential registered with the fake sentinel registry. */
export interface Registered {
  name: string;
  sentinel: string;
  value: string;
  hosts: readonly string[];
}

/**
 * srt's `SandboxManager`, faked: it wraps nothing — the command runs on this host as it is — and
 * records what it is asked. `isolating` gives it the per-command allow lists of the srt release
 * after 0.0.79.
 */
export class FakeManager implements SrtManager {
  config: SandboxRuntimeConfig | undefined;
  dependencyErrors: string[] = [];
  supported = true;
  wrapped: { command: string; customConfig?: Partial<SandboxRuntimeConfig>; commandId?: string }[] =
    [];
  registered: Registered[] = [];
  lists = new Map<string, string[]>();
  resets = 0;

  registerCommandNetworkLists?: SrtManager['registerCommandNetworkLists'];
  unregisterCommandNetworkLists?: SrtManager['unregisterCommandNetworkLists'];

  constructor({ isolating = false }: { isolating?: boolean } = {}) {
    if (isolating) {
      this.registerCommandNetworkLists = (commandId, { allowedDomains = [] }) =>
        void this.lists.set(commandId, allowedDomains);
      this.unregisterCommandNetworkLists = (commandId) => void this.lists.delete(commandId);
    }
  }

  checkDependencies = (): { errors: string[]; warnings: string[] } => ({
    errors: this.dependencyErrors,
    warnings: [],
  });

  getConfig = (): SandboxRuntimeConfig | undefined => this.config;

  getSentinelRegistry = (): ReturnType<SrtManager['getSentinelRegistry']> => ({
    registerWithSentinel: (
      name: string,
      sentinel: string,
      value: string,
      hosts: readonly string[],
    ): string => {
      this.registered.push({ name, sentinel, value, hosts });
      return sentinel;
    },
  });

  initialize = (config: SandboxRuntimeConfig): Promise<void> => {
    this.config = config;
    return Promise.resolve();
  };

  isSupportedPlatform = (): boolean => this.supported;

  reset = (): Promise<void> => {
    this.resets++;
    this.config = undefined;
    return Promise.resolve();
  };

  updateConfig = (config: SandboxRuntimeConfig): void => {
    this.config = config;
  };

  wrapWithSandbox = (
    command: string,
    _binShell?: string,
    customConfig?: Partial<SandboxRuntimeConfig>,
    _abortSignal?: AbortSignal,
    options?: { commandId?: string },
  ): Promise<string> => {
    this.wrapped.push({ command, customConfig, commandId: options?.commandId });
    return Promise.resolve(command);
  };
}

/** A sandbox over a temporary directory, its supervisor run on this host by the fake srt. */
export async function openFakeSandbox({
  ports = [],
  brokerCredentials = true,
  allowed = ['example.com'],
  manager = new FakeManager(),
}: {
  allowed?: string[];
  brokerCredentials?: boolean;
  manager?: FakeManager;
  ports?: number[];
} = {}): Promise<{ manager: FakeManager; root: string; session: SrtNetworkSandboxSession }> {
  const root = await mkdtemp(join(tmpdir(), 'ai-sdk-srt-test-'));
  const workingDirectory = join(root, 'sandbox', 'workspace');
  await mkdir(workingDirectory, { recursive: true });
  const runtime = new SrtRuntime(manager);
  const network = new SandboxNetwork(runtime, allowed);
  const supervisor = new SupervisorHost({
    runtime,
    network,
    filesystem: { denyRead: [], allowRead: [], allowWrite: [root], denyWrite: [] },
    root,
    home: join(root, 'sandbox', 'home'),
    tmpdir: join(root, 'sandbox', 'tmp'),
    environment: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    build: TEST_BUILD,
  });
  const session = new SrtNetworkSandboxSession(
    { id: 'test', supervisor, workingDirectory, processes: new Set(), runtime, network, root },
    ports,
    { brokerCredentials },
  );
  return { manager, root, session };
}
