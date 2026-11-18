import type { Experimental_SandboxSession as SandboxSession } from 'ai';

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import type { Delivery } from '../definitions/workspace.js';

import { deliveredHead, readBundle } from '../git/repository.js';
import { hostGit, hostHasCommit } from '../host/host-git.js';

/** What a checkout's delivery needs to know of it. */
export interface DeliveryInput {
  sandbox: SandboxSession;
  /** The checkout, in the sandbox. */
  directory: string;
  /** The commit it started from, which the host likely has: the bundle leaves it out. */
  base: string;
  /** The session's key, which names the refs the delivery goes through. */
  key: string;
  to: string;
  branch: string;
  commitMessage: string | undefined;
  abortSignal: AbortSignal | undefined;
}

/**
 * Brings the commit a checkout is at into the repository `to` on this host, on a branch: a Git
 * bundle written in the sandbox, read back and fetched here, with no hook of either repository.
 * The branch checked out on this host is never moved, nor a branch that went its own way: the
 * delivery takes the next free name then, `<branch>-2`…
 */
export async function deliver(input: DeliveryInput): Promise<Delivery> {
  const { sandbox, directory, base, key, to, branch, abortSignal } = input;
  if (!isAbsolute(to)) {
    throw new TypeError(`\`to\` must be an absolute path on this host; got ${JSON.stringify(to)}.`);
  }
  await hostGit(to, ['check-ref-format', '--branch', branch], { step: 'deliver' });
  const commit = await deliveredHead(sandbox, {
    directory,
    message: input.commitMessage,
    abortSignal,
  });
  const received = `refs/ai-sdk-harness/delivered/${key}`;
  if (!(await hostHasCommit(to, commit))) {
    const known = (await hostHasCommit(to, base)) ? base : undefined;
    const sent = `refs/ai-sdk-harness/delivery/${key}`;
    const bundle = await readBundle(sandbox, { directory, commit, ref: sent, known, abortSignal });
    const temporary = await mkdtemp(join(tmpdir(), 'ai-sdk-harness-delivery-'));
    try {
      const path = join(temporary, 'delivery.bundle');
      await writeFile(path, bundle);
      await hostGit(
        to,
        ['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', path, `+${sent}:${received}`],
        { step: 'deliver' },
      );
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
  try {
    const target = await targetOf(to, branch, commit);
    await hostGit(to, ['update-ref', `refs/heads/${target}`, commit], { step: 'deliver' });
    return { branch: target, commit };
  } finally {
    await hostGit(to, ['update-ref', '-d', received], { step: 'deliver' }).catch(() => undefined);
  }
}

/**
 * The branch the delivery goes to: `branch` when it is free, or when `commit` only moves it
 * forward; otherwise the first of `<branch>-2`, `<branch>-3`… that is. Never a branch checked out
 * in a working tree of the repository.
 */
async function targetOf(to: string, branch: string, commit: string): Promise<string> {
  const checkedOut = await checkedOutBranches(to);
  for (let index = 1; ; index += 1) {
    const name = index === 1 ? branch : `${branch}-${index}`;
    if (checkedOut.has(`refs/heads/${name}`)) continue;
    const tip = await hostGit(to, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], {
      step: 'deliver',
    }).catch(() => '');
    if (tip === '' || tip === commit) return name;
    const forward = await hostGit(to, ['merge-base', '--is-ancestor', tip, commit], {
      step: 'deliver',
    }).then(
      () => true,
      () => false,
    );
    if (forward) return name;
  }
}

/** The branches checked out in the working trees of the repository at `to`. */
async function checkedOutBranches(to: string): Promise<Set<string>> {
  const listed = await hostGit(to, ['worktree', 'list', '--porcelain'], { step: 'deliver' });
  return new Set(
    listed.split('\n').flatMap((line) => (line.startsWith('branch ') ? [line.slice(7)] : [])),
  );
}
