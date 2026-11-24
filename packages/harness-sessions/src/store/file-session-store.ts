import type { HarnessAgentResumeSessionState } from '@ai-sdk/harness/agent';

import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { SessionRecord, SessionSummary } from '../definitions/session.js';
import type { SessionStore } from '../definitions/store.js';

const RECORD = '.json';
const RESUME_STATE = '.resume.json';

/**
 * A {@link SessionStore} in JSON files, one directory for all: `<id>.json` holds a session and its
 * conversation, `<id>.resume.json` what a suspended one resumes from. Sessions outlive a restart
 * of the process, with nothing to install: for a prototype, a demo, or an application on one
 * machine.
 *
 * The directory is created at the first write, and it and its files are readable by their owner
 * alone (`0700`, `0600`): the conversations, and the resume states, which hold secrets. A file is written whole, then renamed over
 * the old one, so a process stopped in the middle leaves the previous version rather than half a
 * file. It gives no lease methods: one manager per directory.
 */
export function createFileSessionStore<METADATA = unknown>(
  directory: string,
): SessionStore<METADATA> {
  // Dots encoded too: `a.resume` must not name the resume state of `a`.
  const pathOf = (id: string, suffix: string) =>
    join(directory, `${encodeURIComponent(id).replaceAll('.', '%2E')}${suffix}`);

  const read = async <T>(path: string): Promise<T | undefined> => {
    try {
      return JSON.parse(await readFile(path, 'utf8')) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  };

  const write = async (path: string, value: unknown, mode: number) => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(value), { mode });
    await rename(temporary, path);
  };

  return {
    save: async (record, resumeState) => {
      await write(pathOf(record.id, RECORD), record, 0o600);
      if (resumeState === undefined) await rm(pathOf(record.id, RESUME_STATE), { force: true });
      else await write(pathOf(record.id, RESUME_STATE), resumeState, 0o600);
    },
    get: (id) => read<SessionRecord<METADATA>>(pathOf(id, RECORD)),
    list: async () => {
      const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
      const records = await Promise.all(
        names
          .filter((name) => name.endsWith(RECORD) && !name.endsWith(RESUME_STATE))
          .map((name) => read<SessionRecord<METADATA>>(join(directory, name))),
      );
      return records.flatMap((record): SessionSummary<METADATA>[] => {
        if (record === undefined) return [];
        const { messages: _messages, ...summary } = record;
        return [summary];
      });
    },
    getResumeState: (id) => read<HarnessAgentResumeSessionState>(pathOf(id, RESUME_STATE)),
    delete: async (id) => {
      await rm(pathOf(id, RECORD), { force: true });
      await rm(pathOf(id, RESUME_STATE), { force: true });
    },
  };
}
