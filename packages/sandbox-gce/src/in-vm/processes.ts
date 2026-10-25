import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { constants } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

/** The user commands run as, when the agent runs as root and switches to it. */
export interface CommandUser {
  uid: number;
  gid: number;
}

/** A process the agent started, while it runs and for a while after it exits. */
export interface StartedProcess {
  readonly id: string;
  readonly child: ChildProcessWithoutNullStreams;
  /** Its exit code, once it exited: 128 and the signal's number when a signal ended it. */
  readonly exited: Promise<number>;
}

/**
 * Runs the command `$1` in the directory `$2`, with bash as the AI SDK's Vercel sandbox does and the
 * harnesses expect (Pi writes bash), or with sh in an image without bash. Both come as positional
 * arguments, never spliced into the script.
 */
const COMMAND = [
  'cd -- "$2" 2>/dev/null || { echo "cd: $2: No such file or directory" >&2; exit 2; }',
  'if command -v bash >/dev/null 2>&1; then exec bash -c "$1"; fi',
  'exec sh -c "$1"',
].join('\n');

/** How long the exit code of a process is kept, for a caller that lost its stream. */
const EXITED_KEPT_MS = 10 * 60_000;

/** How long a process has to stop on `SIGTERM` before it is killed. */
const KILL_GRACE_MS = 3000;

/** The parent of each process of this machine, read from `/proc`: empty where there is none. */
function parents(): Map<number, number> {
  const parentOf = new Map<number, number>();
  let entries: string[];
  try {
    entries = readdirSync('/proc');
  } catch {
    return parentOf;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, 'utf8');
      // The command name, in parentheses, may hold spaces: the fields after it are fixed.
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      parentOf.set(Number(entry), ppid);
    } catch {
      // Gone meanwhile.
    }
  }
  return parentOf;
}

/** `pid` and every process under it, `pid` first. */
function treeOf(pid: number): number[] {
  const children = new Map<number, number[]>();
  for (const [child, parent] of parents()) {
    children.set(parent, [...(children.get(parent) ?? []), child]);
  }
  const tree = [pid];
  for (let i = 0; i < tree.length; i++) tree.push(...(children.get(tree[i] ?? 0) ?? []));
  return tree;
}

function signal(pid: number, name: NodeJS.Signals): void {
  try {
    process.kill(pid, name);
  } catch {
    // Already gone.
  }
}

/**
 * The processes of the sandbox. Each runs in a process group of its own, so that stopping it stops
 * what it started: the group, and every process under it that left the group, are sent `SIGTERM`,
 * then `SIGKILL` if they linger.
 */
export class Processes {
  private readonly started = new Map<string, StartedProcess>();

  constructor(private readonly user?: CommandUser) {}

  /** Starts `command` in `directory`, with `env` and nothing else; its stdin is the caller's. */
  exec(command: string, directory: string, env: Record<string, string>): StartedProcess {
    const id = randomUUID();
    const shell = ['/bin/sh', '-c', COMMAND, 'sh', command, directory];
    // `setpriv` takes the user's groups too, `docker` among them, which Node.js's `uid` drops.
    const [program = '/bin/sh', ...args] =
      this.user === undefined
        ? shell
        : [
            'setpriv',
            `--reuid=${this.user.uid}`,
            `--regid=${this.user.gid}`,
            '--init-groups',
            '--',
            ...shell,
          ];
    const child = spawn(program, args, { cwd: '/', env, detached: true });
    // A program that exits before reading its standard input must not take the agent down.
    child.stdin.on('error', () => undefined);
    const exited = new Promise<number>((resolve) => {
      child.once('error', () => resolve(127));
      child.once('close', (code, name) =>
        resolve(code ?? 128 + (name === null ? 0 : (constants.signals[name] ?? 15))),
      );
    });
    const started = { id, child, exited };
    this.started.set(id, started);
    void exited.then(() => setTimeout(() => this.started.delete(id), EXITED_KEPT_MS).unref());
    return started;
  }

  /** A process {@link exec} started, while it runs and for a while after it exits. */
  get(id: string): StartedProcess | undefined {
    return this.started.get(id);
  }

  /** Stops a process and everything it started. */
  async kill(id: string): Promise<void> {
    const started = this.started.get(id);
    if (started === undefined) return;
    const pid = started.child.pid;
    if (pid === undefined || started.child.exitCode !== null || started.child.signalCode !== null) {
      return;
    }
    const tree = treeOf(pid);
    signal(-pid, 'SIGTERM');
    for (const member of tree) signal(member, 'SIGTERM');
    const gone = await Promise.race([
      started.exited.then(() => true),
      sleep(KILL_GRACE_MS).then(() => false),
    ]);
    if (gone) {
      // The group may outlive its leader.
      signal(-pid, 'SIGKILL');
      return;
    }
    signal(-pid, 'SIGKILL');
    for (const member of tree) signal(member, 'SIGKILL');
    await started.exited;
  }

  /** Stops every process the agent started. */
  async killAll(): Promise<void> {
    await Promise.all([...this.started.keys()].map((id) => this.kill(id)));
  }
}
