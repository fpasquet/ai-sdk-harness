import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import type { SrtCreationSettings } from '../srt-settings.js';

import { SrtError } from '../errors/srt-error.js';
import { DEFAULT_ALLOWED_DOMAINS } from '../srt-settings.js';

const SANDBOX_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;

/** What a sandbox was created with, kept in its directory for its resumption. */
export interface SandboxRecord {
  readonly version: 1;
  readonly workspace?: string;
  readonly readOnlyWorkspaces: readonly string[];
  readonly allowedDomains: readonly string[];
  readonly hideHome: boolean;
  readonly denyRead: readonly string[];
  readonly allowRead: readonly string[];
  readonly allowWrite: readonly string[];
  readonly denyWrite: readonly string[];
}

/**
 * Where the parts of a sandbox are. The sandbox may only write in `sandbox/`: its settings and its
 * supervisor, beside it, are out of its reach, so that nothing it does outlives its rules.
 */
export interface SandboxLayout {
  /** The sandbox's directory: removed with it. */
  readonly base: string;
  /** Its settings, read again on resumption. */
  readonly record: string;
  /** What the sandbox may write: its home, its own working directory, its temporary files. */
  readonly writable: string;
  readonly home: string;
  readonly tmpdir: string;
  /** Its own working directory, when it has no workspace. */
  readonly workspace: string;
}

/** The directory the sandboxes live in. */
export const defaultDirectory = (): string => join(homedir(), '.ai-sdk-sandbox-runtime');

export function layoutOf(directory: string, sandboxId: string): SandboxLayout {
  if (!SANDBOX_ID.test(sandboxId)) {
    throw new SrtError(
      `Not a sandbox id: "${sandboxId}". Use letters, digits, ".", "_" and "-", up to 63 characters.`,
    );
  }
  const base = join(resolve(directory), sandboxId);
  const writable = join(base, 'sandbox');
  return {
    base,
    record: join(base, 'sandbox.json'),
    writable,
    home: join(writable, 'home'),
    tmpdir: join(writable, 'tmp'),
    workspace: join(writable, 'workspace'),
  };
}

/** The record of a sandbox created with `settings`, its paths made absolute. */
export function recordOf(settings: SrtCreationSettings): SandboxRecord {
  const absolute = (paths: readonly string[] = []): string[] => paths.map((path) => resolve(path));
  return {
    version: 1,
    ...(settings.workspace !== undefined && { workspace: resolve(settings.workspace) }),
    readOnlyWorkspaces: absolute(settings.readOnlyWorkspaces),
    allowedDomains: [...(settings.allowedDomains ?? DEFAULT_ALLOWED_DOMAINS)],
    hideHome: settings.hideHome ?? true,
    denyRead: absolute(settings.denyRead),
    allowRead: absolute(settings.allowRead),
    allowWrite: absolute(settings.allowWrite),
    denyWrite: absolute(settings.denyWrite),
  };
}

/** Creates the directory of a new sandbox, refusing one that exists. */
export async function createSandboxDirectory(
  layout: SandboxLayout,
  record: SandboxRecord,
): Promise<void> {
  if ((await stat(layout.base).catch(() => undefined)) !== undefined) {
    throw new SrtError(`A sandbox already exists at ${layout.base}.`);
  }
  if (
    record.workspace !== undefined &&
    !(await stat(record.workspace).catch(() => undefined))?.isDirectory()
  ) {
    throw new SrtError(`The workspace ${record.workspace} is not a directory.`);
  }
  for (const path of [layout.home, layout.tmpdir, layout.workspace]) {
    await mkdir(path, { recursive: true });
  }
  await writeFile(layout.record, `${JSON.stringify(record, null, 2)}\n`);
}

/** The record of an existing sandbox, or `undefined` when there is none. */
export async function readSandboxRecord(layout: SandboxLayout): Promise<SandboxRecord | undefined> {
  const content = await readFile(layout.record, 'utf8').catch(() => undefined);
  if (content === undefined) return undefined;
  const record = JSON.parse(content) as SandboxRecord;
  if (record.version !== 1) throw new SrtError(`Unknown sandbox record at ${layout.record}.`);
  return record;
}
