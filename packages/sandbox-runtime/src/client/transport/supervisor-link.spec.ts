import type { AddressInfo } from 'node:net';

import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { TEST_BUILD } from '../../../test/build-helpers.js';
import { SupervisorLink } from './supervisor-link.js';

const links: SupervisorLink[] = [];

/** The supervisor, run directly on this host: what srt wraps, without srt. */
async function start(): Promise<SupervisorLink> {
  const settings = JSON.stringify({ home: tmpdir(), tmpdir: tmpdir() });
  const link = await SupervisorLink.start(
    [process.execPath, join(TEST_BUILD, 'in-sandbox', 'supervisor.js'), settings],
    { PATH: process.env.PATH ?? '/usr/bin:/bin' },
  );
  links.push(link);
  return link;
}

afterEach(async () => {
  await Promise.all(links.splice(0).map((link) => link.stop()));
});

describe('SupervisorLink', () => {
  it('starts the supervisor, which runs commands with the variables given', async () => {
    const link = await start();
    const channel = link.open({
      kind: 'spawn',
      command: 'echo "$HOME $GREETING"; echo oops >&2; exit 4',
      cwd: tmpdir(),
      env: { GREETING: 'hi' },
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    channel.onData = (chunk) => out.push(chunk);
    channel.onStderr = (chunk) => err.push(chunk);

    expect(await channel.closed).toEqual({ exitCode: 4 });
    expect(Buffer.concat(out).toString()).toBe(`${tmpdir()} hi\n`);
    expect(Buffer.concat(err).toString()).toBe('oops\n');
    expect(link.running).toBe(true);
  });

  it('carries a connection to a port both ways', async () => {
    const server = createServer((socket) => socket.pipe(socket));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const link = await start();
    const channel = link.open({ kind: 'connect', port: (server.address() as AddressInfo).port });
    const echoed = new Promise<string>((resolve) => {
      channel.onData = (chunk) => resolve(chunk.toString());
    });

    channel.write(Buffer.from('ping'));

    expect(await echoed).toBe('ping');
    const ended = new Promise<void>((resolve) => (channel.onEnd = resolve));
    channel.end();
    await ended;
    expect(await channel.closed).toEqual({ ok: true });
    server.close();
  });

  it('reports the failure of a request', async () => {
    const link = await start();
    const directory = await mkdtemp(join(tmpdir(), 'ai-sdk-srt-link-'));

    expect(
      await link.open({ kind: 'read', path: join(directory, 'missing') }).closed,
    ).toMatchObject({
      error: { code: 'ENOENT' },
    });
    expect(await link.open({ kind: 'connect', port: 1 }).closed).toMatchObject({
      error: { code: 'ECONNREFUSED' },
    });
    const write = link.open({ kind: 'write', path: join(directory, 'missing', 'dir', 'file') });
    write.write(Buffer.from('x'));
    write.end();
    expect(await write.closed).toEqual({ ok: true });
    expect(await link.open({ kind: 'nothing' } as never).closed).toHaveProperty('error');
    await rm(directory, { recursive: true });
  });

  it('stops every process on kill-all, then ends them all when it stops', async () => {
    const link = await start();
    const sleeping = link.open({ kind: 'spawn', command: 'sleep 30', cwd: tmpdir(), env: {} });

    expect(await link.open({ kind: 'kill-all' }).closed).toEqual({ ok: true });
    expect(await sleeping.closed).toEqual({ exitCode: 137 });

    const again = link.open({ kind: 'spawn', command: 'sleep 30', cwd: tmpdir(), env: {} });
    await link.stop();
    expect(await again.closed).toHaveProperty('error.message', 'The sandbox stopped.');
    expect(link.running).toBe(false);
    expect(await link.open({ kind: 'kill-all' }).closed).toHaveProperty('error');
    await link.stop();
  });

  it('says why the supervisor did not start', async () => {
    await expect(
      SupervisorLink.start(['/bin/sh', '-c', 'echo "bwrap: no permission" >&2; exit 1'], {}),
    ).rejects.toThrow('The sandbox stopped: bwrap: no permission');
    await expect(SupervisorLink.start(['/nonexistent/binary'], {})).rejects.toThrow(
      'Could not start the sandbox',
    );
  });
});
