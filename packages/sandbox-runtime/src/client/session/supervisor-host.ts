import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { SandboxNetwork } from '../network/sandbox-network.js';
import type { SrtFilesystem, SrtRuntime } from '../transport/srt-runtime.js';

import { SrtError } from '../errors/srt-error.js';
import { SupervisorLink } from '../transport/supervisor-link.js';
import { packageRoot } from '../utils/package-location.js';
import { shellQuote } from '../utils/shell-quote.js';

/** The built supervisor: `dist/in-sandbox/supervisor.js` and the `protocol/` it imports. */
const packageBuild = (): string => join(packageRoot(), 'dist');

/** Where in its sandbox a supervisor is copied, so that it reads nothing outside the sandbox. */
export const SUPERVISOR_DIRECTORY = '.supervisor';

/** What srt says when the host restricts the user namespaces it needs. */
const RESTRICTED_NAMESPACES = /setgroups|uid map|nested userns|create new namespace/i;

/**
 * The AppArmor profile recent Ubuntu releases load for bwrap: what bwrap runs is confined to
 * `unpriv_bwrap`, which denies every capability, whatever `kernel.apparmor_restrict_unprivileged_userns`
 * says.
 */
export const BWRAP_APPARMOR_PROFILE = '/etc/apparmor.d/bwrap-userns-restrict';

/**
 * `error`, with what to do about it when the host refuses srt's seccomp filter the user namespace
 * it needs: Ubuntu confines what bwrap runs (its `bwrap-userns-restrict` profile), or restricts
 * unprivileged user namespaces (24.04 and later).
 */
export function explained(
  error: unknown,
  confinedBwrap: boolean = existsSync(BWRAP_APPARMOR_PROFILE),
): unknown {
  if (!(error instanceof SrtError) || !RESTRICTED_NAMESPACES.test(error.message)) return error;
  const advice = confinedBwrap
    ? `This host confines what bwrap runs (AppArmor profile ${BWRAP_APPARMOR_PROFILE}: unpriv_bwrap denies every capability), which srt's seccomp filter needs. ` +
      'Run without the filter, `runtime: { allowAllUnixSockets: true }`, and hide the Unix sockets the sandbox should not reach with `denyRead`.'
    : 'This host restricts user namespaces (kernel.apparmor_restrict_unprivileged_userns=1 on Ubuntu 24.04 and later). ' +
      'Lift the restriction with `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`, ' +
      "or run without srt's seccomp filter: `runtime: { allowAllUnixSockets: true }`.";
  return new SrtError(`${error.message}\n\n${advice}`);
}

/** Everything needed to start the supervisor of one sandbox. */
export interface SupervisorPlan {
  readonly runtime: SrtRuntime;
  readonly network: SandboxNetwork;
  readonly filesystem: SrtFilesystem;
  /** The sandbox's own directory. */
  readonly root: string;
  readonly home: string;
  readonly tmpdir: string;
  /** The environment of the supervisor, which every process of the sandbox inherits. */
  readonly environment: Record<string, string>;
  /** The built package to copy the supervisor from. Default: this package's own build. */
  readonly build?: string;
}

/**
 * The supervisor of one sandbox, started on first use and again after it stopped: the one process
 * srt wraps for the sandbox, under its filesystem rules, tagged with a commandId of its own.
 */
export class SupervisorHost {
  private current: Promise<SupervisorLink> | undefined;

  constructor(private readonly plan: SupervisorPlan) {}

  /** The running supervisor, started if it is not. */
  link(): Promise<SupervisorLink> {
    if (this.current !== undefined) return this.current;
    const started = this.start();
    this.current = started;
    const forget = (): void => {
      if (this.current === started) this.current = undefined;
    };
    started.then((link) => link.exited.then(forget), forget);
    return started;
  }

  /** Stops the supervisor and every process of the sandbox. Idempotent. */
  async stop(): Promise<void> {
    const link = await this.current?.catch(() => undefined);
    this.current = undefined;
    await link?.stop();
  }

  private async start(): Promise<SupervisorLink> {
    const { runtime, network, filesystem, home, tmpdir } = this.plan;
    const script = await this.install();
    await mkdir(tmpdir, { recursive: true });
    const commandId = randomBytes(16).toString('base64url');
    const command = [process.execPath, script, JSON.stringify({ home, tmpdir })]
      .map(shellQuote)
      .join(' ');
    const wrapped = await runtime.wrap(command, { filesystem, commandId });
    network.attach(commandId);
    try {
      const link = await SupervisorLink.start(['/bin/bash', '-c', wrapped], this.plan.environment);
      void link.exited.then(() => network.detach(commandId));
      return link;
    } catch (error) {
      network.detach(commandId);
      throw explained(error);
    }
  }

  /** Copies the supervisor into the sandbox, afresh each start; returns its path. */
  private async install(): Promise<string> {
    const build = this.plan.build ?? packageBuild();
    const target = join(this.plan.root, SUPERVISOR_DIRECTORY);
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'package.json'), '{ "type": "module" }\n');
    for (const folder of ['in-sandbox', 'protocol']) {
      await cp(join(build, folder), join(target, folder), { recursive: true, force: true });
    }
    return join(target, 'in-sandbox', 'supervisor.js');
  }
}
