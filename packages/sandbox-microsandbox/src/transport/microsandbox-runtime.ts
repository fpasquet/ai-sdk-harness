import type { NetworkPolicy } from 'microsandbox';

import { Sandbox, SandboxNotFoundError, Snapshot } from 'microsandbox';

import type { PortBinding } from './microsandbox-connection.js';

import { MicrosandboxConnection } from './microsandbox-connection.js';
import { WORKSPACE } from './sandbox-scripts.js';

/** The sub-builders `SandboxBuilder` hands to its callbacks, which the SDK types as `any`. */
interface MountBuilder {
  bind(host: string): MountBuilder;
}
interface NetworkBuilder {
  policy(policy: NetworkPolicy): NetworkBuilder;
  tls(configure: (tls: unknown) => unknown): NetworkBuilder;
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
  readonly networkPolicy?: NetworkPolicy;
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
  if (spec.user !== undefined) builder.user(spec.user);
  for (const { hostPort, guestPort } of spec.ports) builder.port(hostPort, guestPort);
  const { workspace, networkPolicy } = spec;
  if (workspace !== undefined) {
    builder.volume(WORKSPACE, (mount: MountBuilder) => mount.bind(workspace));
  }
  builder.network((network: NetworkBuilder) => {
    if (networkPolicy !== undefined) network.policy(networkPolicy);
    // Configuring TLS turns interception on, with microsandbox's own certificate authority.
    return network.tls((tls) => tls);
  });
  return new MicrosandboxConnection(name, await builder.create());
}

/**
 * Creates the sandbox `name` from the disk snapshot `snapshot`. A snapshot only holds a disk: the
 * resources, the user, the ports and the mounts are set again here.
 */
export async function restoreSandbox(
  name: string,
  snapshot: string,
  spec: SandboxSpec,
): Promise<MicrosandboxConnection> {
  const builder = Sandbox.restore(snapshot).name(name).cpus(spec.cpus).memory(spec.memory);
  if (spec.user !== undefined) builder.user(spec.user);
  for (const { hostPort, guestPort } of spec.ports) builder.port(hostPort, guestPort);
  const { workspace, networkPolicy } = spec;
  if (workspace !== undefined) builder.volume(WORKSPACE, (mount) => mount.bind(workspace));
  if (networkPolicy !== undefined) builder.networkPolicy(networkPolicy);
  return new MicrosandboxConnection(name, await builder.restore());
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

/** Saves the disk of the stopped sandbox `sandbox` as the snapshot `name`, in the group `group`. */
export async function snapshotSandbox(sandbox: string, name: string, group: string): Promise<void> {
  await Snapshot.builder(name).fromSandbox(sandbox).group(group).create();
}
