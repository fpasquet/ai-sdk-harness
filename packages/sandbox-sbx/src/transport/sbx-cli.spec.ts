import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { FakeSbx } from '../../test/fake-sbx.js';

import { createFakeSbx } from '../../test/fake-sbx.js';
import { SbxError } from '../errors/sbx-error.js';
import { SbxNotSignedInError } from '../errors/sbx-not-signed-in-error.js';
import { SbxTimeoutError } from '../errors/sbx-timeout-error.js';
import { SbxCli } from './sbx-cli.js';

describe('SbxCli', () => {
  let sbx: FakeSbx;
  let cli: SbxCli;

  beforeEach(() => {
    sbx = createFakeSbx();
    sbx.addSandbox('box');
    cli = new SbxCli(sbx.binary);
  });
  afterEach(() => sbx.dispose());

  it('runs a command and hands back its output as bytes, its errors as text', async () => {
    const result = await cli.run(['exec', 'box', 'sh', '-c', 'printf out; printf err >&2; exit 3']);

    expect(result.exitCode).toBe(3);
    expect(result.stdout.toString()).toBe('out');
    expect(result.stderr).toBe('err');
  });

  it('writes bytes and streams to stdin', async () => {
    const bytes = await cli.check(['exec', '-i', 'box', 'cat'], {
      stdin: new TextEncoder().encode('from bytes'),
    });
    const stream = await cli.check(['exec', '-i', 'box', 'cat'], {
      stdin: new Blob(['from a stream']).stream(),
    });

    expect(bytes).toBe('from bytes');
    expect(stream).toBe('from a stream');
  });

  it('forwards its own variables to the sbx client', async () => {
    const output = await cli.check(
      ['exec', '-e', 'GREETING', 'box', 'sh', '-c', 'echo $GREETING'],
      {
        env: { GREETING: 'hello' },
      },
    );

    expect(output.trim()).toBe('hello');
  });

  it('throws an SbxError on a non-zero exit', async () => {
    const failure = cli.check(['exec', 'box', 'sh', '-c', 'echo nope >&2; exit 1']);

    await expect(failure).rejects.toBeInstanceOf(SbxError);
    await expect(failure).rejects.toMatchObject({
      args: ['exec', 'box', 'sh', '-c', 'echo nope >&2; exit 1'],
      exitCode: 1,
      message: '`sbx exec` exited with 1: nope',
    });
  });

  it('says how to install sbx when the binary is missing', async () => {
    const missing = new SbxCli('/nowhere/sbx');

    await expect(missing.run(['ls'])).rejects.toThrow(
      /The Docker Sandboxes CLI `\/nowhere\/sbx` was not found/,
    );
  });

  it('refuses to start once aborted', async () => {
    await expect(cli.run(['ls'], { abortSignal: AbortSignal.abort() })).rejects.toThrow();
  });

  it('reports a process killed by a signal as 128 + its number', async () => {
    const result = await cli.run(['exec', 'box', 'sh', '-c', 'kill -9 $$']);

    expect(result.exitCode).toBe(137);
  });

  describe('deadline', () => {
    it('stops a control command past its deadline', async () => {
      sbx.update((state) => {
        state.hangOn = ['ports'];
      });
      const bounded = new SbxCli(sbx.binary, false, { commandTimeoutMs: 200 });

      const failure = bounded.check(['ports', 'box', '--json']);

      await expect(failure).rejects.toBeInstanceOf(SbxTimeoutError);
      await expect(failure).rejects.toMatchObject({
        args: ['ports', 'box', '--json'],
        exitCode: 124,
        timeoutMs: 200,
        message: '`sbx ports` did not finish within 200 ms and was stopped.',
      });
    });

    it('leaves an unbounded command to its abort signal', async () => {
      const bounded = new SbxCli(sbx.binary, false, { commandTimeoutMs: 100 });

      const output = await bounded.check(['exec', 'box', 'sh', '-c', 'sleep 0.4; echo done'], {
        unbounded: true,
      });

      expect(output.trim()).toBe('done');
    });
  });

  describe('retry', () => {
    it('asks again a listing that did not answer in time', async () => {
      sbx.update((state) => {
        state.hangOnce = ['ls --json'];
      });
      // Long enough for the fake `sbx` to start on a busy CI runner: the try that hangs waits it out.
      const bounded = new SbxCli(sbx.binary, false, {
        commandTimeoutMs: 2000,
        retryDelaysMs: [10],
      });

      const output = await bounded.check(['ls', '--json'], { retry: true });

      expect(JSON.parse(output)).toMatchObject([{ name: 'box' }]);
      expect(sbx.calls().filter((call) => call[0] === 'ls')).toHaveLength(2);
    });

    it('asks again a listing while the Docker sign-in service is unavailable', async () => {
      sbx.update((state) => {
        state.unavailableOnce = ['ls --json'];
      });
      const patient = new SbxCli(sbx.binary, false, { retryDelaysMs: [10] });

      const output = await patient.check(['ls', '--json'], { retry: true });

      expect(JSON.parse(output)).toMatchObject([{ name: 'box' }]);
    });

    it('gives up after its last try, and never retries a command that does not allow it', async () => {
      sbx.update((state) => {
        state.unavailableOnce = ['ls --json', 'ls --json', 'ports'];
      });
      const patient = new SbxCli(sbx.binary, false, { retryDelaysMs: [10] });

      await expect(patient.check(['ls', '--json'], { retry: true })).rejects.toThrow(
        /docker login service unavailable/,
      );
      await expect(patient.check(['ports', 'box', '--json'])).rejects.toBeInstanceOf(SbxError);
      expect(sbx.calls().filter((call) => call[0] === 'ports')).toHaveLength(1);
    });

    it('stops waiting to retry once aborted', async () => {
      sbx.update((state) => {
        state.unavailableOnce = ['ls --json'];
      });
      const patient = new SbxCli(sbx.binary, false, { retryDelaysMs: [60_000] });
      const controller = new AbortController();

      const listing = patient.check(['ls', '--json'], {
        retry: true,
        abortSignal: controller.signal,
      });
      setTimeout(() => controller.abort(), 200);

      await expect(listing).rejects.toThrow();
    });
  });

  describe('signed out', () => {
    it('says to sign in again when sbx is signed out', async () => {
      sbx.update((state) => {
        state.signedOut = true;
      });

      const failure = cli.check(['ports', 'box', '--publish', '4000']);

      await expect(failure).rejects.toBeInstanceOf(SbxNotSignedInError);
      await expect(failure).rejects.toBeInstanceOf(SbxError);
      await expect(failure).rejects.toThrow(/Run `sbx login` on this host/);
    });

    it('fails the next commands at once, without running sbx, for a while', async () => {
      sbx.update((state) => {
        state.signedOut = true;
      });
      await expect(cli.run(['ls', '--json'])).rejects.toBeInstanceOf(SbxNotSignedInError);
      const calls = sbx.calls().length;

      await expect(cli.run(['exec', 'box', 'true'])).rejects.toBeInstanceOf(SbxNotSignedInError);
      expect(() => cli.start(['exec', 'box', 'sh', '-c', 'sleep 60'])).toThrow(SbxNotSignedInError);
      expect(sbx.calls()).toHaveLength(calls);
    });

    it('runs sbx again once the hold is over, and forgets the sign-out when it answers', async () => {
      const held = new SbxCli(sbx.binary, false, { signedOutHoldMs: 0 });
      sbx.update((state) => {
        state.signedOut = true;
      });
      await expect(held.run(['ls', '--json'])).rejects.toBeInstanceOf(SbxNotSignedInError);
      sbx.update((state) => {
        state.signedOut = false;
      });

      const output = await held.check(['exec', 'box', 'sh', '-c', 'echo back']);

      expect(output.trim()).toBe('back');
    });

    it('does not take a failing command for a sign-out', async () => {
      await expect(cli.check(['exec', 'box', 'sh', '-c', 'exit 1'])).rejects.not.toBeInstanceOf(
        SbxNotSignedInError,
      );
      await expect(cli.check(['exec', 'box', 'true'])).resolves.toBe('');
    });
  });
});
