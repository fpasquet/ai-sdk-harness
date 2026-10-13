import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fake } from '../../test/fake-microsandbox.js';
import { MicrosandboxCommandError } from '../errors/microsandbox-command-error.js';
import { MicrosandboxSandboxNotFoundError } from '../errors/microsandbox-sandbox-not-found-error.js';
import { MicrosandboxConnection } from './microsandbox-connection.js';

describe('MicrosandboxConnection', () => {
  let connection: MicrosandboxConnection;

  beforeEach(() => {
    fake.addSandbox('box', { ports: [{ guestPort: 4000, hostPort: 41000 }] });
    connection = new MicrosandboxConnection('box');
  });
  afterEach(() => fake.reset());

  it('runs a command and hands back its output as bytes, its errors as text', async () => {
    const result = await connection.run(['sh', '-c', 'printf out; printf err >&2; exit 3']);

    expect(result.exitCode).toBe(3);
    expect(Buffer.from(result.stdout).toString()).toBe('out');
    expect(result.stderr).toBe('err');
  });

  it('passes the arguments as an array, the directory, the variables and the user', async () => {
    const output = await connection.check(['sh', '-c', 'echo "$0 $GREETING"', 'arg one'], {
      cwd: '/',
      env: { GREETING: 'hello' },
      user: 'root',
    });

    expect(output).toBe('arg one hello\n');
    expect(fake.sandbox('box').execs.at(-1)).toMatchObject({
      argv: ['sh', '-c', 'echo "$0 $GREETING"', 'arg one'],
      cwd: '/',
      env: { GREETING: 'hello' },
      user: 'root',
    });
  });

  it('writes bytes to stdin', async () => {
    const output = await connection.check(['cat'], { stdin: new TextEncoder().encode('in') });

    expect(output).toBe('in');
  });

  it('throws a MicrosandboxCommandError on a non-zero exit', async () => {
    const failure = connection.check(['sh', '-c', 'echo nope >&2; exit 1']);

    await expect(failure).rejects.toBeInstanceOf(MicrosandboxCommandError);
    await expect(failure).rejects.toMatchObject({
      command: ['sh', '-c', 'echo nope >&2; exit 1'],
      exitCode: 1,
      stderr: 'nope\n',
      message: '`sh -c echo nope >&2; exit 1` exited with 1 in the sandbox: nope',
    });
  });

  it('reports a killed command as 137, and killing it twice or after it exited is a no-op', async () => {
    const running = await connection.start(['sleep', '30']);

    await running.kill();
    await running.kill();

    expect(await running.wait()).toEqual({ exitCode: 137 });
    const done = await connection.start(['true']);
    await done.wait();
    await expect(done.kill()).resolves.toBeUndefined();
  });

  it('rejects wait() when the sandbox restarts under a running command', async () => {
    const running = await connection.start(['sleep', '30']);

    await connection.modify({
      secrets: { S: { value: 'v', placeholder: 'p' } },
      policy: 'restart',
    });

    await expect(running.wait()).rejects.toThrow('exec session ended without exit event');
  });

  it('keeps streaming one output when the reader gave up on the other', async () => {
    const running = await connection.start(['sh', '-c', 'echo out; echo err >&2; echo more']);
    await running.stderr.cancel();

    expect(await new Response(running.stdout).text()).toBe('out\nmore\n');
    expect(await running.wait()).toEqual({ exitCode: 0 });
  });

  it('starts a stopped sandbox again on the next command', async () => {
    await connection.run(['true']);
    await connection.stop();
    expect(fake.sandbox('box').status).toBe('stopped');

    expect(await connection.check(['echo', 'back'])).toBe('back\n');
    expect(fake.sandbox('box').status).toBe('running');
  });

  it('starts the sandbox again when it was stopped from elsewhere', async () => {
    await connection.run(['true']);
    fake.sandbox('box').status = 'stopped';

    expect(await connection.check(['echo', 'back'])).toBe('back\n');
  });

  it('starts a stopped sandbox once for the commands that need it at once', async () => {
    await connection.stop();

    await Promise.all([
      connection.run(['true']),
      connection.run(['true']),
      connection.run(['true']),
    ]);

    expect(fake.sandbox('box').starts).toBe(1);
  });

  it('tries to connect again after a failed attempt', async () => {
    await connection.stop();
    fake.fail('connect');
    await expect(connection.run(['true'])).rejects.toThrow('connect failed');

    fake.failures.clear();

    expect(await connection.check(['echo', 'back'])).toBe('back\n');
  });

  it('stops a sandbox stopped from elsewhere without an error', async () => {
    await connection.run(['true']);
    fake.sandbox('box').status = 'stopped';

    await expect(connection.stop()).resolves.toBeUndefined();
  });

  it('stops a sandbox it never connected to, and stopping twice is a no-op', async () => {
    await connection.stop();
    await connection.stop();

    expect(fake.sandbox('box').status).toBe('stopped');
  });

  it('reads the TCP ports the sandbox was published with, and its secret names', async () => {
    await connection.modify({
      secrets: { S: { value: 'v', placeholder: 'p' } },
      policy: 'restart',
    });

    expect(await connection.publishedPorts()).toEqual([{ guestPort: 4000, hostPort: 41000 }]);
    expect(await connection.secretNames()).toEqual(['S']);
  });

  it('destroys the sandbox, and destroying it twice is a no-op', async () => {
    await connection.destroy();
    await connection.destroy();

    expect(fake.sandboxes.has('box')).toBe(false);
  });

  it('says when the sandbox does not exist', async () => {
    const missing = new MicrosandboxConnection('missing');

    await expect(missing.run(['true'])).rejects.toBeInstanceOf(MicrosandboxSandboxNotFoundError);
    await expect(missing.stop()).resolves.toBeUndefined();
  });

  it('lets any other error of the SDK through', async () => {
    fake.fail('connect');

    await expect(connection.run(['true'])).rejects.toThrow('connect failed');
  });
});
