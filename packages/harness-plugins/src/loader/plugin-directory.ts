import type { Dirent } from 'node:fs';

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import { PluginLoadError } from '../errors/plugin-load-error.js';

/** A text file of a plugin directory, at `path` relative to the directory it was listed from. */
export interface DirectoryFile {
  path: string;
  content: string;
  executable: boolean;
}

/** Past this size, a file is not shipped to the sandbox. */
const MAX_FILE_BYTES = 512 * 1024;
const SKIPPED = new Set(['.DS_Store', '.git', 'node_modules']);

/** The JSON file at `path`, or `undefined` when there is none. */
export async function readJsonFile(path: string): Promise<unknown> {
  const text = await readTextFile(path);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new PluginLoadError(path, `not valid JSON (${(error as Error).message}).`);
  }
}

/** The text of the file at `path`, or `undefined` when there is none. */
export async function readTextFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new PluginLoadError(path, (error as Error).message);
  }
}

/**
 * The text files under `directory`, at paths relative to it with `/` separators — `.git`,
 * `node_modules`, binary files and files over 512 KiB left out. Empty when it does not exist.
 */
export async function listFiles(directory: string): Promise<DirectoryFile[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true, recursive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new PluginLoadError(directory, (error as Error).message);
  }
  const files: DirectoryFile[] = [];
  for (const entry of entries) {
    const path = join(entry.parentPath, entry.name);
    const parts = relative(directory, path).split(sep);
    if (!entry.isFile() || parts.some((part) => SKIPPED.has(part))) continue;
    const file = await readTextEntry(path);
    if (file !== undefined) files.push({ path: parts.join('/'), ...file });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function readTextEntry(path: string): Promise<Omit<DirectoryFile, 'path'> | undefined> {
  const stats = await stat(path);
  if (stats.size > MAX_FILE_BYTES) return undefined;
  const bytes = await readFile(path);
  if (bytes.includes(0)) return undefined;
  return { content: bytes.toString('utf8'), executable: (stats.mode & 0o111) !== 0 };
}
