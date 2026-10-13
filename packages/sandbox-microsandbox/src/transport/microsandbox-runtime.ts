import type { NetworkPolicy } from 'microsandbox';

import { Sandbox, SandboxNotFoundError, Snapshot } from 'microsandbox';
import { randomBytes } from 'node:crypto';

import type { PortBinding } from './microsandbox-connection.js';

import { MicrosandboxConnection } from './microsandbox-connection.js';
import { DOCKER_DATA, WORKSPACE } from './sandbox-scripts.js';

/** The sub-builders `SandboxBuilder` hands to its callbacks, which the SDK types as `any`. */
interface MountBuilder {
  bind(host: string): MountBuilder;
  owned(options: { kind: 'disk'; sizeMib: number }): MountBuilder;
  readonly(): MountBuilder;
  nosuid(): MountBuilder;
  nodev(): MountBuilder;
}
interface NetworkBuilder {
  policy(policy: NetworkPolicy): NetworkBuilder;
  tls(configure: (tls: unknown) => unknown): NetworkBuilder;
  maxTcpConnections(max: number): NetworkBuilder;
}

/** What a new sandbox is made of, whether it boots from an image or from a template snapshot. */
export interface SandboxSpec {
  readonly cpus: number;
  /** In MiB. */
  readonly memory: number;
  readonly user?: string;
  readonly ports: readonly PortBinding[];
  /** A directory of this host, mounted read-write at {@link WORKSPACE}. */
  readonly workspace?: string;
  /** Directories of this host, mounted read-only at their own path. */
  readonly readOnlyWorkspaces?: readonly string[];
  readonly networkPolicy?: NetworkPolicy;
  /** The in-guest security profile. */
  readonly security?: 'default' | 'restricted';
  /** In seconds. */
  readonly maxDuration?: number;
  /** In seconds. */
  readonly idleTimeout?: number;
  readonly maxTcpConnections?: number;
  /** A Docker daemon's data disk, in MiB, when the sandbox runs Docker. */
  readonly docker?: { readonly diskSize: number };
}

/** What `SandboxBuilder` and `RestoreBuilder` share, which `configure()` sets the same way. */
interface CommonBuilder {
  user(user: string): unknown;
  port(hostPort: number, guestPort: number): unknown;
  volume(guestPath: string, configure: (mount: MountBuilder) => MountBuilder): unknown;
  security(profile: 'default' | 'restricted'): unknown;
  maxDuration(secs: number): unknown;
  idleTimeout(secs: number): unknown;
}

/**
 * Sets on `builder` what a sandbox gets whether it boots from an image or from a snapshot: its
 * user, ports, mounts, security profile and lifetime. Host mounts never carry setuid binaries or
 * device files into the sandbox.
 */
function configure(builder: CommonBuilder, spec: SandboxSpec): void {
  if (spec.user !== undefined) builder.user(spec.user);
  for (const { hostPort, guestPort } of spec.ports) builder.port(hostPort, guestPort);
  const { workspace, readOnlyWorkspaces = [] } = spec;
  if (workspace !== undefined) {
    builder.volume(WORKSPACE, (mount) => mount.bind(workspace).nosuid().nodev());
  }
  for (const path of readOnlyWorkspaces) {
    builder.volume(path, (mount) => mount.bind(path).readonly().nosuid().nodev());
  }
  if (spec.docker !== undefined) {
    const sizeMib = spec.docker.diskSize;
    builder.volume(DOCKER_DATA, (mount) => mount.owned({ kind: 'disk', sizeMib }));
  }
  if (spec.security !== undefined) builder.security(spec.security);
  if (spec.maxDuration !== undefined) builder.maxDuration(spec.maxDuration);
  if (spec.idleTimeout !== undefined) builder.idleTimeout(spec.idleTimeout);
}

/**
 * Creates the sandbox `name` from the OCI image `image`, detached so that it outlives this process.
 * TLS interception is on from the start: microsandbox needs it to put secrets in HTTPS requests,
 * and to match their host against a network policy.
 */
export async function createSandbox(
  name: string,
  image: string,
  spec: SandboxSpec,
): Promise<MicrosandboxConnection> {
  const builder = Sandbox.builder(name)
    .image(image)
    .detached(true)
    .cpus(spec.cpus)
    .memory(spec.memory);
  configure(builder, spec);
  const { networkPolicy, maxTcpConnections } = spec;
  builder.network((network: NetworkBuilder) => {
    if (networkPolicy !== undefined) network.policy(networkPolicy);
    if (maxTcpConnections !== undefined) network.maxTcpConnections(maxTcpConnections);
    // Configuring TLS turns interception on, with microsandbox's own certificate authority.
    return network.tls((tls) => tls);
  });
  return new MicrosandboxConnection(name, await builder.create());
}

/**
 * The secret that turns TLS interception on in a restored sandbox. It is allowed for a host that
 * never resolves, so its value is never put in a request. Not named `AISDK_…`: the credential
 * broker leaves it alone.
 */
export const TLS_SENTINEL_SECRET = 'MICROSANDBOX_TLS_INTERCEPTION';

/**
 * Creates the sandbox `name` from the disk snapshot `snapshot`. A snapshot only holds a disk: the
 * resources, the user, the ports and the mounts are set again here.
 *
 * A restored sandbox does not intercept TLS, and `Sandbox.restore()` cannot turn it on: until then,
 * a policy allowing hosts by name refuses their HTTPS. A secret turns it on, so one is registered
 * at once, at the cost of a restart, for the sandbox to behave as one created from the image.
 */
export async function restoreSandbox(
  name: string,
  snapshot: string,
  spec: SandboxSpec,
): Promise<MicrosandboxConnection> {
  const builder = Sandbox.restore(snapshot).name(name).cpus(spec.cpus).memory(spec.memory);
  // The Docker disk comes with the snapshot, each restored sandbox getting a copy of its own:
  // microsandbox refuses an owned volume at restore.
  configure(builder, { ...spec, docker: undefined });
  const { networkPolicy, maxTcpConnections } = spec;
  if (networkPolicy !== undefined) builder.networkPolicy(networkPolicy);
  if (maxTcpConnections !== undefined) builder.maxTcpConnections(maxTcpConnections);
  const connection = new MicrosandboxConnection(name, await builder.restore());
  try {
    await connection.modify({
      secrets: {
        [TLS_SENTINEL_SECRET]: {
          value: randomBytes(16).toString('hex'),
          placeholder: `msb-tls-${randomBytes(8).toString('hex')}`,
          allowedHosts: ['tls-interception.invalid'],
        },
      },
      policy: 'restart',
    });
  } catch (error) {
    await connection.destroy();
    throw error;
  }
  return connection;
}

/** A connection to the existing sandbox `name`, started on its first command if it is stopped. */
export function connectSandbox(name: string): MicrosandboxConnection {
  return new MicrosandboxConnection(name);
}

/** Whether a sandbox named `name` exists on this host, running or not. */
export async function sandboxExists(name: string): Promise<boolean> {
  try {
    await Sandbox.get(name);
    return true;
  } catch (error) {
    if (error instanceof SandboxNotFoundError) return false;
    throw error;
  }
}

/** The reference `restoreSandbox()` takes for the snapshot named `name`, if there is one. */
export async function findSnapshot(name: string): Promise<string | undefined> {
  return (await Snapshot.list()).find((snapshot) => snapshot.name === name)?.reference;
}

/** The snapshots whose name starts with `prefix`, with when they were made. */
export async function listSnapshots(
  prefix: string,
): Promise<{ name: string; reference: string; createdAt: Date }[]> {
  return (await Snapshot.list()).flatMap(({ name, reference, createdAt }) =>
    name?.startsWith(prefix) === true ? [{ name, reference, createdAt }] : [],
  );
}

/**
 * Removes the snapshot `reference`. The sandboxes restored from it are copies of their own: they
 * keep running, and start again, without it.
 */
export async function removeSnapshot(reference: string): Promise<void> {
  await Snapshot.remove(reference);
}

/** Saves the disk of the stopped sandbox `sandbox` as the snapshot `name`. */
export async function snapshotSandbox(sandbox: string, name: string): Promise<void> {
  await Snapshot.builder(name).fromSandbox(sandbox).create();
}
