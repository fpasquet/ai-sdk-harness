import type { HarnessV1SandboxTemplate } from '@ai-sdk/harness';

import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';

import type {
  SrtConnectionSettings,
  SrtNetworkSandboxSessionCreateOptions,
  SrtNetworkSandboxSessionResumeOptions,
} from '../srt-settings.js';
import type { LinkChannel } from '../transport/supervisor-link.js';
import type { SandboxLayout, SandboxRecord } from './sandbox-directory.js';

import { SrtError } from '../errors/srt-error.js';
import { SrtSandboxNotFoundError } from '../errors/srt-sandbox-not-found-error.js';
import { SandboxNetwork } from '../network/sandbox-network.js';
import { SrtNetworkSandboxSession } from '../session/srt-network-sandbox-session.js';
import { SupervisorHost } from '../session/supervisor-host.js';
import { srtRuntime } from '../transport/srt-runtime.js';
import { currentHost, environmentOf, filesystemOf } from './filesystem-policy.js';
import {
  createSandboxDirectory,
  defaultDirectory,
  layoutOf,
  readSandboxRecord,
  recordOf,
} from './sandbox-directory.js';

/** A session over the sandbox at `layout`, its supervisor started. */
async function open(
  { id, layout, record }: { id: string; layout: SandboxLayout; record: SandboxRecord },
  { ports = [], brokerCredentials = true, runtime: runtimeSettings }: SrtConnectionSettings,
): Promise<SrtNetworkSandboxSession> {
  const runtime = await srtRuntime(runtimeSettings);
  const network = new SandboxNetwork(runtime, record.allowedDomains);
  const host = currentHost();
  const supervisor = new SupervisorHost({
    runtime,
    network,
    filesystem: filesystemOf(layout, record, host),
    root: layout.base,
    home: layout.home,
    tmpdir: layout.tmpdir,
    environment: environmentOf(layout, host),
  });
  await supervisor.link();
  const handle = {
    id,
    supervisor,
    workingDirectory: record.workspace ?? layout.workspace,
    processes: new Set<LinkChannel>(),
    runtime,
    network,
    root: layout.base,
  };
  return new SrtNetworkSandboxSession(handle, ports, { brokerCredentials });
}

/** Runs the setup commands, then prepares the template, in a new sandbox. */
async function prepare(
  session: SrtNetworkSandboxSession,
  {
    setup,
    template,
    abortSignal,
  }: { abortSignal?: AbortSignal; setup: readonly string[]; template?: HarnessV1SandboxTemplate },
): Promise<void> {
  for (const command of setup) {
    const { exitCode, stderr } = await session.run({ command, abortSignal });
    if (exitCode !== 0) {
      throw new SrtError(`The setup command \`${command}\` failed (${exitCode}): ${stderr.trim()}`);
    }
  }
  await template?.prepare({ session: session.restricted(), abortSignal });
}

/**
 * Creates a sandbox on this host, behind srt: a directory of its own for its home and its
 * temporary files, a workspace it may write, the rest of the host read-only — the user's home
 * hidden — and a network that only reaches the allowed hosts. A `template` is prepared in it, as the
 * `setup` commands are, before it is handed over; a sandbox that fails them is removed.
 *
 * Creating it starts srt for the process if it is not running yet: srt must be able to run here
 * (`bwrap`, `socat` and `rg` on Linux, `rg` on macOS), or this throws an {@link SrtError} saying
 * what is missing.
 */
export async function createSrtNetworkSandboxSession(
  options: SrtNetworkSandboxSessionCreateOptions = {},
): Promise<SrtNetworkSandboxSession> {
  const {
    sandboxId = `srt-${randomBytes(4).toString('hex')}`,
    directory = defaultDirectory(),
    template,
    abortSignal,
    setup = [],
  } = options;
  const layout = layoutOf(directory, sandboxId);
  const record = recordOf(options);
  await createSandboxDirectory(layout, record);
  let session: SrtNetworkSandboxSession | undefined;
  try {
    session = await open({ id: sandboxId, layout, record }, options);
    await prepare(session, { setup, template, abortSignal });
    return session;
  } catch (error) {
    await session?.stop().catch(() => undefined);
    await rm(layout.base, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Reattaches a sandbox created earlier, by this process or another: its files are where they were,
 * its rules those it was created with. Its processes are not: they stopped with the process that
 * ran them. Throws {@link SrtSandboxNotFoundError} when there is no such sandbox.
 */
export async function resumeSrtNetworkSandboxSession(
  options: SrtNetworkSandboxSessionResumeOptions,
): Promise<SrtNetworkSandboxSession> {
  const layout = layoutOf(options.directory ?? defaultDirectory(), options.sandboxId);
  const record = await readSandboxRecord(layout);
  if (record === undefined) throw new SrtSandboxNotFoundError(options.sandboxId);
  return open({ id: options.sandboxId, layout, record }, options);
}
