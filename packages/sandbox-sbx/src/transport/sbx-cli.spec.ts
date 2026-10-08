import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { FakeSbx } from '../../test/fake-sbx.js';

import { createFakeSbx } from '../../test/fake-sbx.js';
import { SbxError } from '../errors/sbx-error.js';
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
});
