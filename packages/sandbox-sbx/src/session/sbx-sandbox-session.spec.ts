import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { FakeSbx } from '../../test/fake-sbx.js';

import { createFakeSbx } from '../../test/fake-sbx.js';
import { SbxCli } from '../transport/sbx-cli.js';
import { assertEnvNames, SbxSandboxSession } from './sbx-sandbox-session.js';

describe('SbxSandboxSession', () => {
  let sbx: FakeSbx;
  let root: string;
  let session: SbxSandboxSession;

  beforeEach(() => {
    sbx = createFakeSbx();
    root = sbx.addSandbox('box');
    mkdirSync(root, { recursive: true });
    session = new SbxSandboxSession({
      cli: new SbxCli(sbx.binary),
      name: 'box',
      workingDirectory: root,
      processes: new Set(),
      clearEnv: ['ANTHROPIC_API_KEY'],
    });
  });
  afterEach(() => sbx.dispose());

  it('describes the sandbox for the agent', () => {
    expect(session.description).toContain(`Docker Sandbox "box"`);
    expect(session.description).toContain(root);
  });

  describe('run', () => {
    it('runs a command in the working directory and collects its output', async () => {
      const result = await session.run({ command: 'pwd; echo oops >&2; exit 2' });

      expect(result).toEqual({ exitCode: 2, stdout: `${root}\n`, stderr: 'oops\n' });
    });

    it('resolves a relative working directory against the sandbox one', async () => {
      const { stdout } = await session.run({ command: 'pwd', workingDirectory: 'nested/dir' });

      expect(stdout.trim()).toBe(join(root, 'nested/dir'));
    });

    it('forwards variables by name, never by value', async () => {
      const { stdout } = await session.run({
        command: 'echo "$TOKEN"',
        env: { TOKEN: 'secret-value' },
      });

      expect(stdout.trim()).toBe('secret-value');
      const exec = sbx.callsOf('exec').at(-1);
      expect(exec).toEqual(expect.arrayContaining(['-e', 'TOKEN']));
      expect(exec?.join(' ')).not.toContain('secret-value');
    });

    it('drops the cleared variables unless the command sets them', async () => {
      const cleared = await session.run({ command: 'echo "[$ANTHROPIC_API_KEY]"' });
      const set = await session.run({
        command: 'echo "[$ANTHROPIC_API_KEY]"',
        env: { ANTHROPIC_API_KEY: 'mine' },
      });

      expect(cleared.stdout.trim()).toBe('[]');
      expect(set.stdout.trim()).toBe('[mine]');
    });

    it('rejects a variable name sbx could not forward', async () => {
      await expect(session.run({ command: 'true', env: { 'A=B': 'x' } })).rejects.toThrow(
        'Not an environment variable name: A=B',
      );
      expect(() => assertEnvNames(['OK_NAME', '_x1'])).not.toThrow();
    });
  });

  describe('spawn', () => {
    it('streams the output of a long-running process and waits for it', async () => {
      const spawned = await session.spawn({ command: 'echo started; sleep 0.1; echo done' });

      expect(await new Response(spawned.stdout).text()).toBe('started\ndone\n');
      expect(await spawned.wait()).toEqual({ exitCode: 0 });
    });

    it('kills the process inside the sandbox, not only the sbx client', async () => {
      const spawned = await session.spawn({ command: 'sleep 30' });
      await new Promise((resolve) => setTimeout(resolve, 200));

      await spawned.kill();
      await spawned.kill();

      expect((await spawned.wait()).exitCode).not.toBe(0);
    });

    it('rejects wait() with the abort reason when aborted', async () => {
      const controller = new AbortController();
      const spawned = await session.spawn({ command: 'sleep 30', abortSignal: controller.signal });
      await new Promise((resolve) => setTimeout(resolve, 200));

      controller.abort(new Error('stop it'));

      await expect(spawned.wait()).rejects.toThrow('stop it');
    });

    it('rejects wait() with an AbortError when aborted without an Error reason', async () => {
      const controller = new AbortController();
      const spawned = await session.spawn({ command: 'sleep 30', abortSignal: controller.signal });
      await new Promise((resolve) => setTimeout(resolve, 200));

      controller.abort('no reason');

      await expect(spawned.wait()).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('refuses to start once aborted', async () => {
      await expect(
        session.spawn({ command: 'true', abortSignal: AbortSignal.abort() }),
      ).rejects.toThrow();
    });
  });

  describe('files', () => {
    it('writes text, creating parent directories, and reads it back', async () => {
      await session.writeTextFile({ path: 'a/b/hello.txt', content: 'héllo\nworld\nagain' });

      expect(readFileSync(join(root, 'a/b/hello.txt'), 'utf8')).toBe('héllo\nworld\nagain');
      expect(await session.readTextFile({ path: 'a/b/hello.txt' })).toBe('héllo\nworld\nagain');
    });

    it('reads a range of lines, 1-based and inclusive', async () => {
      writeFileSync(join(root, 'lines.txt'), 'one\ntwo\nthree\nfour');

      expect(await session.readTextFile({ path: 'lines.txt', startLine: 2, endLine: 3 })).toBe(
        'two\nthree',
      );
      expect(await session.readTextFile({ path: 'lines.txt', startLine: 3 })).toBe('three\nfour');
      expect(await session.readTextFile({ path: 'lines.txt', endLine: 99 })).toBe(
        'one\ntwo\nthree\nfour',
      );
    });

    it('round-trips bytes untouched', async () => {
      const bytes = new Uint8Array([0, 255, 10, 13, 128]);

      await session.writeBinaryFile({ path: '/tmp/../' + join(root, 'blob.bin'), content: bytes });

      expect(await session.readBinaryFile({ path: 'blob.bin' })).toEqual(bytes);
      const stream = await session.readFile({ path: 'blob.bin' });
      expect(new Uint8Array(await new Response(stream).arrayBuffer())).toEqual(bytes);
    });

    it('answers null for a missing file', async () => {
      expect(await session.readFile({ path: 'missing' })).toBeNull();
      expect(await session.readTextFile({ path: 'missing' })).toBeNull();
    });

    it('refuses to read a directory', async () => {
      mkdirSync(join(root, 'dir'));

      await expect(session.readBinaryFile({ path: 'dir' })).rejects.toMatchObject({
        code: 'EISDIR',
      });
    });

    it('reports a read the sandbox could not do', async () => {
      sbx.update((state) => state.failOn.push('cat --'));

      await expect(session.readBinaryFile({ path: 'x' })).rejects.toThrow(/Could not read/);
    });

    it('reports a write the sandbox could not do', async () => {
      writeFileSync(join(root, 'file'), '');

      await expect(session.writeTextFile({ path: 'file/child', content: 'x' })).rejects.toThrow(
        /Could not write/,
      );
    });
  });
});
