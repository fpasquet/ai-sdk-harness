import { afterEach, describe, expect, it } from 'vitest';

import { FakeManager } from '../../../test/fake-srt.js';
import { SrtError } from '../errors/srt-error.js';
import { resetSrtRuntime, SrtRuntime, srtRuntime } from './srt-runtime.js';

afterEach(() => resetSrtRuntime());

describe('srtRuntime', () => {
  it('starts srt once, allowing nothing, its TLS terminated for the credentials', async () => {
    const manager = new FakeManager();

    const runtime = await srtRuntime(
      { ripgrepPath: '/opt/rg', allowAllUnixSockets: true },
      manager,
    );

    expect(await srtRuntime({ allowAllUnixSockets: true, ripgrepPath: '/opt/rg' }, manager)).toBe(
      runtime,
    );
    expect(manager.config).toMatchObject({
      network: {
        allowedDomains: [],
        deniedDomains: [],
        tlsTerminate: {},
        allowAllUnixSockets: true,
      },
      filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
      credentials: { envVars: [] },
      ripgrep: { command: '/opt/rg' },
    });
  });

  it('passes the binaries it is given, and the nested mode', async () => {
    const manager = new FakeManager();

    await srtRuntime(
      { bwrapPath: '/opt/bwrap', socatPath: '/opt/socat', enableWeakerNestedSandbox: true },
      manager,
    );

    expect(manager.config).toMatchObject({
      bwrapPath: '/opt/bwrap',
      socatPath: '/opt/socat',
      enableWeakerNestedSandbox: true,
    });
  });

  it('lets a bridge listen on the loopback of macOS, which has no network namespace', async () => {
    const manager = new FakeManager();

    await srtRuntime({}, manager, 'darwin');

    expect(manager.config?.network.allowLocalBinding).toBe(true);
  });

  it('refuses Windows, where the supervisor cannot run', async () => {
    await expect(srtRuntime({}, new FakeManager(), 'win32')).rejects.toThrow('not on win32');
  });

  it('refuses other settings once started', async () => {
    const manager = new FakeManager();
    await srtRuntime({}, manager);

    await expect(srtRuntime({ socatPath: '/opt/socat' }, manager)).rejects.toThrow(
      'other runtime settings',
    );
  });

  it('says what srt lacks to run here, then lets a later call try again', async () => {
    const manager = new FakeManager();
    manager.dependencyErrors = ['socat not installed'];

    await expect(srtRuntime({}, manager)).rejects.toThrow('- socat not installed');
    expect(manager.resets).toBe(1);

    manager.dependencyErrors = [];
    await expect(srtRuntime({}, manager)).resolves.toBeInstanceOf(SrtRuntime);
  });

  it('refuses a platform srt does not support, and reports a failed start', async () => {
    const unsupported = new FakeManager();
    unsupported.supported = false;
    await expect(srtRuntime({}, unsupported)).rejects.toThrow(SrtError);

    const failing = new FakeManager();
    failing.initialize = () => Promise.reject(new Error('no bwrap'));
    await expect(srtRuntime({}, failing)).rejects.toThrow('srt did not start: no bwrap');
  });
});

describe('SrtRuntime', () => {
  it('wraps a command under its filesystem rules, tagged with its commandId', async () => {
    const manager = new FakeManager();
    const filesystem = { denyRead: ['/h'], allowRead: [], allowWrite: ['/s'], denyWrite: [] };

    await new SrtRuntime(manager).wrap('node x', { filesystem, commandId: 'id' });

    expect(manager.wrapped).toEqual([
      {
        command: 'node x',
        customConfig: { filesystem, network: { allowedDomains: [], deniedDomains: [] } },
        commandId: 'id',
      },
    ]);
  });

  it('keeps one allow list for the process, the union of every sandbox, before per-command lists', async () => {
    const manager = new FakeManager();
    await manager.initialize({
      network: { allowedDomains: [], deniedDomains: [] },
      filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
    });
    const runtime = new SrtRuntime(manager);

    runtime.allow('a', ['example.com', 'example.com']);
    runtime.allow('b', ['github.com']);
    expect(runtime.isolatesNetworks).toBe(false);
    expect(manager.config?.network.allowedDomains).toEqual(['example.com', 'github.com']);

    runtime.forget('a');
    runtime.forget('unknown');
    expect(manager.config?.network.allowedDomains).toEqual(['github.com']);
  });

  it('gives each sandbox a list of its own with per-command lists', () => {
    const manager = new FakeManager({ isolating: true });
    const runtime = new SrtRuntime(manager);

    runtime.allow('a', ['example.com']);
    expect(runtime.isolatesNetworks).toBe(true);
    expect(manager.lists.get('a')).toEqual(['example.com']);

    runtime.forget('a');
    expect(manager.lists.has('a')).toBe(false);
  });

  it('registers a credential under one name per placeholder, and empties it on withdrawal', () => {
    const manager = new FakeManager();
    const runtime = new SrtRuntime(manager);

    runtime.inject({ placeholder: 'p1', value: 'v1', hosts: ['h'] });
    runtime.inject({ placeholder: 'p1', value: 'v2', hosts: ['h'] });
    runtime.inject({ placeholder: 'p2', value: 'v3', hosts: ['h'] });
    runtime.withdraw('p1');
    runtime.withdraw('unknown');

    expect(manager.registered.map(({ name, value }) => [name, value])).toEqual([
      ['ai-sdk-sandbox-runtime-1', 'v1'],
      ['ai-sdk-sandbox-runtime-1', 'v2'],
      ['ai-sdk-sandbox-runtime-2', 'v3'],
      ['ai-sdk-sandbox-runtime-1', ''],
    ]);
    expect(manager.registered.at(-1)?.hosts).toEqual([]);
  });
});
