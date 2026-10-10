import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { FakeSandbox } from '../../test/fake-microsandbox.js';

import { fake } from '../../test/fake-microsandbox.js';
import { MicrosandboxConnection } from '../transport/microsandbox-connection.js';
import { MicrosandboxSandboxSession } from './microsandbox-sandbox-session.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('MicrosandboxSandboxSession', () => {
  let sandbox: FakeSandbox;
  /** The host directory standing for the sandbox's `/workspace`. */
  let workspace: string;
  let session: MicrosandboxSandboxSession;

  beforeEach(() => {
    sandbox = fake.addSandbox('box');
    workspace = join(sandbox.root, 'workspace');
    mkdirSync(workspace);
    session = new MicrosandboxSandboxSession({
      connection: new MicrosandboxConnection('box'),
      workingDirectory: '/workspace',
      processes: new Set(),
    });
  });
  afterEach(() => fake.reset());

  it('describes the sandbox for the agent', () => {
    expect(session.description).toContain('microsandbox "box"');
    expect(session.description).toContain('/workspace');
  });

  describe('run', () => {
    it('runs a command in the working directory and collects its output', async () => {
      const result = await session.run({ command: 'pwd; echo oops >&2; exit 2' });

      expect(result).toEqual({ exitCode: 2, stdout: `${workspace}\n`, stderr: 'oops\n' });
      expect(sandbox.execs.at(-1)).toMatchObject({ cwd: '/workspace' });
    });

    it('resolves a relative working directory against the sandbox one', async () => {
      mkdirSync(join(workspace, 'nested/dir'), { recursive: true });

      await session.run({ command: 'true', workingDirectory: 'nested/dir' });

      expect(sandbox.execs.at(-1)).toMatchObject({ cwd: '/workspace/nested/dir' });
    });

    it("forwards the command's variables, and nothing of this process's environment", async () => {
      process.env.HOST_ONLY = 'host';
      const { stdout } = await session.run({
        command: 'echo "$TOKEN [$HOST_ONLY]"',
        env: { TOKEN: 'secret-value' },
      });
      delete process.env.HOST_ONLY;

      expect(stdout.trim()).toBe('secret-value []');
      expect(sandbox.execs.at(-1)?.argv.join(' ')).not.toContain('secret-value');
    });
  });

  describe('spawn', () => {
    it('streams the output of a long-running process and waits for it', async () => {
      const spawned = await session.spawn({ command: 'echo started; sleep 0.1; echo done' });

      expect(await new Response(spawned.stdout).text()).toBe('started\ndone\n');
      expect(await spawned.wait()).toEqual({ exitCode: 0 });
    });

    it('kills the process and every process it started', async () => {
      const spawned = await session.spawn({ command: 'sleep 30 & sleep 30; wait' });
      await sleep(100);

      await spawned.kill();

      expect(await spawned.wait()).toEqual({ exitCode: 137 });
    });

    it('rejects wait() with the abort reason when aborted', async () => {
      const controller = new AbortController();
      const spawned = await session.spawn({ command: 'sleep 30', abortSignal: controller.signal });
      await sleep(100);

      controller.abort(new Error('stop it'));

      await expect(spawned.wait()).rejects.toThrow('stop it');
    });

    it('rejects wait() with an AbortError when aborted without an Error reason', async () => {
      const controller = new AbortController();
      const spawned = await session.spawn({ command: 'sleep 30', abortSignal: controller.signal });

      controller.abort('no reason');

      await expect(spawned.wait()).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('refuses to start once aborted', async () => {
      await expect(
        session.spawn({ command: 'true', abortSignal: AbortSignal.abort() }),
      ).rejects.toThrow();
      expect(sandbox.execs).toHaveLength(0);
    });
  });

  describe('files', () => {
    it('writes text, creating parent directories, and reads it back', async () => {
      await session.writeTextFile({ path: 'a/b/hello.txt', content: 'héllo\nworld\nagain' });

      expect(readFileSync(join(workspace, 'a/b/hello.txt'), 'utf8')).toBe('héllo\nworld\nagain');
      expect(await session.readTextFile({ path: 'a/b/hello.txt' })).toBe('héllo\nworld\nagain');
    });

    it('reads a range of lines, 1-based and inclusive', async () => {
      writeFileSync(join(workspace, 'lines.txt'), 'one\ntwo\nthree\nfour');

      expect(await session.readTextFile({ path: 'lines.txt', startLine: 2, endLine: 3 })).toBe(
        'two\nthree',
      );
      expect(await session.readTextFile({ path: 'lines.txt', startLine: 3 })).toBe('three\nfour');
      expect(await session.readTextFile({ path: 'lines.txt', endLine: 99 })).toBe(
        'one\ntwo\nthree\nfour',
      );
    });

    it('round-trips bytes untouched, absolute paths included', async () => {
      const bytes = new Uint8Array([0, 255, 10, 13, 128]);

      await session.writeBinaryFile({ path: '/workspace/blob.bin', content: bytes });

      expect(await session.readBinaryFile({ path: 'blob.bin' })).toEqual(bytes);
      const stream = await session.readFile({ path: 'blob.bin' });
      expect(new Uint8Array(await new Response(stream).arrayBuffer())).toEqual(bytes);
    });

    it('answers null for a missing file', async () => {
      expect(await session.readFile({ path: 'missing' })).toBeNull();
      expect(await session.readTextFile({ path: 'missing' })).toBeNull();
    });

    it('refuses to read a directory', async () => {
      mkdirSync(join(workspace, 'dir'));

      await expect(session.readBinaryFile({ path: 'dir' })).rejects.toMatchObject({
        code: 'EISDIR',
      });
    });

    it('reports a read the sandbox could not do', async () => {
      writeFileSync(join(workspace, 'locked'), 'x', { mode: 0o000 });

      await expect(session.readBinaryFile({ path: 'locked' })).rejects.toThrow(/Could not read/);
    });

    it('reports a write the sandbox could not do', async () => {
      writeFileSync(join(workspace, 'file'), '');

      await expect(session.writeTextFile({ path: 'file/child', content: 'x' })).rejects.toThrow(
        /Could not write/,
      );
    });

    it('refuses to read or write once aborted', async () => {
      const abortSignal = AbortSignal.abort();

      await expect(session.readBinaryFile({ path: 'x', abortSignal })).rejects.toThrow();
      await expect(
        session.writeTextFile({ path: 'x', content: '', abortSignal }),
      ).rejects.toThrow();
    });
  });
});
