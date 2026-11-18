import { describe, expect, it } from 'vitest';

import { checkMounts, checkSandboxId, proxyRunArgs, sandboxRunArgs } from './run-args.js';

/** The value given after `flag`, each time. */
const valuesOf = (args: readonly string[], flag: string): string[] =>
  args.flatMap((arg, index) => (arg === flag ? [args[index + 1] ?? ''] : []));

describe('the containers of a sandbox', () => {
  const sandbox = sandboxRunArgs({
    name: 'box',
    network: 'box-net',
    image: 'node:24-slim',
    mounts: [
      { from: '/home/ada/www/api', to: '/home/ada/www/api' },
      { from: '/srv/cache', to: '/cache', readOnly: true },
    ],
    workingDirectory: '/workspace',
    user: '1000:1000',
    env: { CI: '1' },
  });

  it('puts the sandbox on its internal network alone, its traffic sent to the proxy', () => {
    expect(valuesOf(sandbox, '--network')).toEqual(['box-net']);
    expect(valuesOf(sandbox, '--network-alias')).toEqual(['sandbox']);
    expect(valuesOf(sandbox, '--env')).toEqual(
      expect.arrayContaining([
        'HTTPS_PROXY=http://egress:3128',
        'http_proxy=http://egress:3128',
        'NO_PROXY=localhost,127.0.0.1',
        'CI=1',
      ]),
    );
    expect(sandbox).not.toContain('--publish');
  });

  it('runs it with its limits, its user, no capability, and its mounts', () => {
    expect(valuesOf(sandbox, '--memory')).toEqual([String(4 * 1024 ** 3)]);
    expect(valuesOf(sandbox, '--cpus')).toEqual(['2']);
    expect(valuesOf(sandbox, '--pids-limit')).toEqual(['512']);
    expect(valuesOf(sandbox, '--user')).toEqual(['1000:1000']);
    expect(valuesOf(sandbox, '--cap-drop')).toEqual(['ALL']);
    expect(valuesOf(sandbox, '--security-opt')).toEqual(['no-new-privileges']);
    expect(valuesOf(sandbox, '--mount')).toEqual([
      'type=bind,source=/home/ada/www/api,target=/home/ada/www/api',
      'type=bind,source=/srv/cache,target=/cache,readonly',
    ]);
    expect(sandbox.slice(-4)).toEqual(['tail', 'node:24-slim', '-f', '/dev/null']);
  });

  it('takes the limits it is given', () => {
    const limited = sandboxRunArgs({
      name: 'box',
      network: 'box-net',
      image: 'node:24-slim',
      mounts: [],
      limits: { memory: '1g', cpus: 0.5, processes: 64 },
      workingDirectory: '/workspace',
      user: undefined,
      env: {},
    });
    expect(valuesOf(limited, '--memory')).toEqual(['1g']);
    expect(valuesOf(limited, '--cpus')).toEqual(['0.5']);
    expect(valuesOf(limited, '--pids-limit')).toEqual(['64']);
    expect(limited).not.toContain('--user');
  });

  it('runs the proxy read-only, its forwarded ports published on the loopback alone', () => {
    const proxy = proxyRunArgs({
      name: 'box-egress',
      stateDirectory: '/state/box',
      script: '/pkg/dist/proxy/egress-proxy.js',
      forwards: [{ listen: 40_000, host: 'sandbox', port: 8080 }],
      user: '1000:1000',
      image: 'node:24-slim',
    });
    expect(valuesOf(proxy, '--publish')).toEqual(['127.0.0.1::40000']);
    expect(proxy).toContain('--read-only');
    expect(valuesOf(proxy, '--mount')).toEqual([
      'type=bind,source=/state/box,target=/egress',
      'type=bind,source=/pkg/dist/proxy/egress-proxy.js,target=/egress-proxy.mjs,readonly',
    ]);
    expect(proxy.slice(-2)).toEqual(['node:24-slim', '/egress-proxy.mjs']);
    expect(valuesOf(proxy, '--env')).toContain(
      'EGRESS_FORWARDS=[{"listen":40000,"host":"sandbox","port":8080}]',
    );
    const typescript = proxyRunArgs({
      name: 'box-egress',
      stateDirectory: '/state/box',
      script: '/pkg/src/proxy/egress-proxy.ts',
      forwards: [],
      user: undefined,
      image: 'node:24-slim',
    });
    expect(typescript.at(-1)).toBe('/egress-proxy.mts');
  });
});

describe('checks', () => {
  it('takes the names Docker takes', () => {
    expect(() => checkSandboxId('ai-sdk-docker-1a2b')).not.toThrow();
    for (const name of ['', '-box', 'box/1', 'b'.repeat(57), 'box name']) {
      expect(() => checkSandboxId(name)).toThrow(TypeError);
    }
  });

  it('takes mounts between absolute paths', () => {
    expect(() => checkMounts([{ from: '/a', to: '/b' }])).not.toThrow();
    expect(() => checkMounts([{ from: 'a', to: '/b' }])).toThrow(TypeError);
    expect(() => checkMounts([{ from: '/a', to: 'b' }])).toThrow(TypeError);
    expect(() => checkMounts([{ from: '/a,b', to: '/b' }])).toThrow(TypeError);
  });
});
