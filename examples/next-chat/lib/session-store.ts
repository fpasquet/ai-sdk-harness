import type { HarnessAgentResumeSessionState } from '@ai-sdk/harness/agent';
import type { SessionRecord, SessionStore, SessionSummary } from 'ai-sdk-harness-sessions';

import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * A `SessionStore` of JSON files, so the conversations outlive the dev server: one file per
 * session, and one beside it for the resume state of a suspended one, readable by this user only.
 * It holds the token of the harness bridge: keep the directory out of Git (`.data/` is ignored).
 *
 * A real application keeps its sessions in its database, behind the same five methods.
 */
export function createFileSessionStore<METADATA>(directory: string): SessionStore<METADATA> {
  const recordPath = (id: string) => join(directory, `${encodeURIComponent(id)}.json`);
  const resumePath = (id: string) => join(directory, `${encodeURIComponent(id)}.resume.json`);

  const read = async <T>(path: string): Promise<T | undefined> => {
    try {
      return JSON.parse(await readFile(path, 'utf8')) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  };

  return {
    save: async (record, resumeState) => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(recordPath(record.id), JSON.stringify(record));
      if (resumeState === undefined) await rm(resumePath(record.id), { force: true });
      else await writeFile(resumePath(record.id), JSON.stringify(resumeState), { mode: 0o600 });
    },
    get: (id) => read<SessionRecord<METADATA>>(recordPath(id)),
    list: async () => {
      const names = await readdir(directory).catch(() => []);
      const records = await Promise.all(
        names
          .filter((name) => name.endsWith('.json') && !name.endsWith('.resume.json'))
          .map((name) => read<SessionRecord<METADATA>>(join(directory, name))),
      );
      return records.flatMap((record): SessionSummary<METADATA>[] => {
        if (record === undefined) return [];
        const { messages: _messages, ...summary } = record;
        return [summary];
      });
    },
    getResumeState: (id) => read<HarnessAgentResumeSessionState>(resumePath(id)),
    delete: async (id) => {
      await rm(recordPath(id), { force: true });
      await rm(resumePath(id), { force: true });
    },
  };
}
