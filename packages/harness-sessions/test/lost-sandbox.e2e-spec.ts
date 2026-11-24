import type { HarnessV1SandboxTemplate } from '@ai-sdk/harness';
import type { UIMessageChunk } from 'ai';
import type { GceAuth } from 'ai-sdk-sandbox-gce';

import { createClaudeCode } from '@ai-sdk/harness-claude-code';
import { createHarnessSandboxTemplate, HarnessAgent } from '@ai-sdk/harness/agent';
import {
  createGceNetworkSandboxSession,
  deleteGceSandbox,
  deleteGceSandboxTemplate,
  resumeGceNetworkSandboxSession,
} from 'ai-sdk-sandbox-gce';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { SessionManager } from '../src/index.js';

import {
  createSessionManager,
  SANDBOX_RESUME_CHUNK,
  sandboxPerSession,
  TURN_RETRY_CHUNK,
} from '../src/index.js';

/**
 * A real Claude Code turn whose Compute Engine machine is stopped in the middle, as a Spot VM is
 * preempted, its disk kept. Needs:
 *
 * - `GCE_SANDBOX_URL`, the URL of a deployed sandbox service, and `gcloud` signed in with
 *   `roles/run.invoker` on it and the right to stop its instances (`GCE_SANDBOX_PROJECT` when it
 *   is not gcloud's default project; `GCE_SANDBOX_SERVICE_TOKEN` and `GCE_SANDBOX_AUTH` as
 *   `sandbox-gce`'s own e2e tests take them);
 * - `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`: the proxy of the service brokers them through
 *   a base URL route, where the login of the `claude` CLI would open a tunnel it refuses.
 *
 * Skipped otherwise. It never runs in CI: it costs a machine for some minutes, the template of
 * Claude Code it boots from, both deleted at the end, and a few model calls.
 */
const url = process.env['GCE_SANDBOX_URL'];
const credential = process.env['CLAUDE_CODE_OAUTH_TOKEN'] ?? process.env['ANTHROPIC_API_KEY'];
const project = process.env['GCE_SANDBOX_PROJECT'];
const service = {
  url: url ?? '',
  auth: (process.env['GCE_SANDBOX_AUTH'] ?? 'gcloud') as GceAuth,
  serviceToken: process.env['GCE_SANDBOX_SERVICE_TOKEN'],
  ports: [4000],
  // The bridge of Claude Code installs its dependencies from npm.
  allowedHosts: ['registry.npmjs.org'],
};
/** What the service puts before a sandbox's name to name its machine: its SANDBOX_INSTANCE_PREFIX. */
const prefix = process.env['GCE_SANDBOX_INSTANCE_PREFIX'] ?? 'sbx-';
const sandboxId = `e2e-lost-${randomBytes(3).toString('hex')}`;
const harness = createClaudeCode();
const agent = new HarnessAgent({ harness, model: 'claude-haiku-4-5', permissionMode: 'allow-all' });

interface Machine {
  id: string;
  name: string;
  status: string;
  zone: string;
}

async function gcloud(...args: string[]): Promise<string> {
  const { stdout } = await promisify(execFile)('gcloud', [
    ...args,
    ...(project === undefined ? [] : ['--project', project]),
  ]);
  return stdout;
}

/** The machines of the sandbox: named after it, or labelled with its name when from the warm pool. */
async function machinesOf(id: string): Promise<Machine[]> {
  const listed = JSON.parse(
    await gcloud(
      'compute',
      'instances',
      'list',
      `--filter=name=${prefix}${id} OR labels.ai-sdk-sandbox-name=${id}`,
      '--format=json(id,name,status,zone)',
    ),
  ) as Machine[];
  return listed.map((machine) => ({ ...machine, zone: machine.zone.split('/').at(-1) ?? '' }));
}

describe.skipIf(url === undefined || credential === undefined)(
  'a sandbox lost with its machine, on Compute Engine',
  () => {
    let template: HarnessV1SandboxTemplate | undefined;
    let sessions: SessionManager;
    const errors: { action: string; error: unknown }[] = [];

    beforeAll(async () => {
      template = await createHarnessSandboxTemplate({ harnesses: [harness] });
      sessions = createSessionManager({
        agent: () => agent,
        sandboxes: sandboxPerSession({
          create: async () => {
            const sandbox = await createGceNetworkSandboxSession({
              ...service,
              sandboxId,
              template,
            });
            // Written before the machine is lost: its disk must still hold it after.
            await sandbox.writeTextFile({ path: 'kept.txt', content: 'before the stop' });
            return sandbox;
          },
          resume: () => resumeGceNetworkSandboxSession({ ...service, sandboxId }),
          remove: () => deleteGceSandbox({ ...service, sandboxId }),
        }),
        turnRetries: { attempts: 2, delayMs: 1000 },
        onError: (error, { action }) => errors.push({ action, error }),
      });
    });

    afterAll(async () => {
      await sessions?.close('lost').catch(() => undefined);
      await sessions?.shutdown();
      await deleteGceSandbox({ ...service, sandboxId }).catch(() => undefined);
      if (template !== undefined) await deleteGceSandboxTemplate({ ...service, template });
    });

    it(
      'resumes the same machine on its disk, and the turn carries on',
      { timeout: 1_500_000 },
      async () => {
        await sessions.create({ id: 'lost', metadata: undefined });
        const turn = await sessions.send('lost', {
          message:
            'Run the shell command `sleep 90 && echo slept` with your Bash tool. Once it is ' +
            'over, answer with the single word DONE, and nothing else.',
        });
        const chunks: UIMessageChunk[] = [];
        let stopped: Machine | undefined;
        for await (const chunk of turn.stream) {
          chunks.push(chunk);
          // The agent is in its command: the machine goes, as a preempted Spot VM does.
          if (stopped === undefined && chunk.type === 'tool-input-available') {
            const [machine] = await machinesOf(sandboxId);
            if (machine === undefined) throw new Error(`No machine holds ${sandboxId}.`);
            stopped = machine;
            await gcloud('compute', 'instances', 'stop', machine.name, '--zone', machine.zone);
          }
        }
        const session = await turn.done;

        expect(stopped).toBeDefined();
        const types = chunks.map(({ type }) => type);
        const retry = types.indexOf(TURN_RETRY_CHUNK);
        const resume = types.indexOf(SANDBOX_RESUME_CHUNK);
        expect(retry).toBeGreaterThanOrEqual(0);
        expect(resume).toBeGreaterThan(retry);
        expect(chunks[resume]).toMatchObject({ data: { attempt: 1 }, transient: true });

        // The same machine started again, on its disk: no new one.
        const machines = await machinesOf(sandboxId);
        expect(machines.map(({ id, status }) => ({ id, status }))).toEqual([
          { id: stopped?.id, status: 'RUNNING' },
        ]);
        const sandbox = await resumeGceNetworkSandboxSession({ ...service, sandboxId });
        expect(await sandbox.readTextFile({ path: 'kept.txt' })).toBe('before the stop');

        expect(session.error).toBeUndefined();
        expect(session.status).toBe('idle');
        expect(errors.map(({ action }) => action)).toContain('retry turn');
        const record = await sessions.get('lost');
        const answer = record?.messages.at(-1);
        expect(answer?.role).toBe('assistant');
        expect(JSON.stringify(answer?.parts)).toContain('DONE');
      },
    );
  },
);
