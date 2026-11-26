import { readFileSync } from 'node:fs';

import { createLogger } from '../common/logger.js';
import { DEFAULT_PROXY_ADMIN_PORT, DEFAULT_PROXY_PORT } from '../protocol/proxy.js';
import { createAdminServer } from './admin-server.js';
import {
  DEFAULT_MAX_CONNECTIONS,
  DEFAULT_ROUTE_CONNECTIONS,
  DEFAULT_TOTAL_CONNECTIONS,
  EgressProxy,
} from './egress-proxy.js';
import { IDLE_EXIT_CODE, watchIdle } from './idle-exit.js';
import { SandboxRegistry } from './registry.js';

type Environment = Readonly<Record<string, string | undefined>>;

/**
 * The proxy's settings, from its environment, which the systemd unit of its machine sets.
 * `limits` is the text of `/proc/self/limits`, for the total of connections by default.
 */
export function proxyConfig(
  env: Environment,
  limits: string | undefined = readLimits(),
): {
  adminPort: number;
  allowPrivateNetwork: boolean;
  host: string;
  /** How long the proxy runs with no sandbox before it exits for its machine to power off. */
  idleExitMs?: number;
  maxConnections: number;
  port: number;
  /**
   * Where the proxy takes the direct connections of programs that ignore the proxy variables: TLS
   * on `tlsPort` (443), plain HTTP on `httpPort` (80). Unset, it takes none.
   */
  tlsPort?: number;
  httpPort?: number;
  routeConnections: number;
  token: string;
  totalConnections: number;
} {
  const token = env['SANDBOX_PROXY_TOKEN'];
  if (token === undefined || token.length < 16) {
    throw new Error(
      'SANDBOX_PROXY_TOKEN is required, 16 characters at least: the sandbox service proves itself with it.',
    );
  }
  return {
    port: Number.parseInt(env['SANDBOX_PROXY_PORT'] ?? String(DEFAULT_PROXY_PORT), 10),
    tlsPort: directPort('SANDBOX_PROXY_TLS_PORT', env),
    httpPort: directPort('SANDBOX_PROXY_HTTP_PORT', env),
    adminPort: Number.parseInt(
      env['SANDBOX_PROXY_ADMIN_PORT'] ?? String(DEFAULT_PROXY_ADMIN_PORT),
      10,
    ),
    host: env['HOST'] ?? '0.0.0.0',
    allowPrivateNetwork: env['SANDBOX_ALLOW_PRIVATE_NETWORK'] === 'true',
    maxConnections: connectionCount('SANDBOX_PROXY_MAX_CONNECTIONS', env, {
      fallback: DEFAULT_MAX_CONNECTIONS,
      min: 1,
    }),
    routeConnections: connectionCount('SANDBOX_PROXY_ROUTE_CONNECTIONS', env, {
      fallback: DEFAULT_ROUTE_CONNECTIONS,
      min: 0,
    }),
    totalConnections: connectionCount('SANDBOX_PROXY_TOTAL_CONNECTIONS', env, {
      fallback: totalConnectionsFor(limits),
      min: 1,
    }),
    idleExitMs: idleExitMs(env['SANDBOX_PROXY_IDLE_EXIT_MINUTES']),
    token,
  };
}

/** A port of the direct connections, 1 to 65535; `undefined` when unset or empty. */
function directPort(name: string, env: Environment): number | undefined {
  const value = env[name];
  if (value === undefined || value === '') return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name}: \`${value}\` is not a port.`);
  }
  return port;
}

/** `SANDBOX_PROXY_IDLE_EXIT_MINUTES`, a positive integer: never exits when unset. */
function idleExitMs(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`SANDBOX_PROXY_IDLE_EXIT_MINUTES: \`${value}\` is not a positive integer.`);
  }
  return parsed * 60_000;
}

/** Descriptors kept apart from the connections: the proxy's own files, and upstream sockets kept alive. */
const SPARE_DESCRIPTORS = 1024;

/**
 * The most connections the descriptors of the process allow, two for each, its soft `Max open
 * files` in `limits` less {@link SPARE_DESCRIPTORS}: {@link DEFAULT_TOTAL_CONNECTIONS} when that
 * limit is unknown or unlimited.
 */
export function totalConnectionsFor(limits: string | undefined): number {
  const soft = /^Max open files\s+(\d+)/m.exec(limits ?? '')?.[1];
  if (soft === undefined) return DEFAULT_TOTAL_CONNECTIONS;
  return Math.max(1, Math.floor((Number(soft) - SPARE_DESCRIPTORS) / 2));
}

function readLimits(): string | undefined {
  try {
    return readFileSync('/proc/self/limits', 'utf8');
  } catch {
    return undefined;
  }
}

/** A number of connections the variable `name` sets, an integer from `min`: `fallback` when unset. */
function connectionCount(
  name: string,
  env: Environment,
  { fallback, min }: { fallback: number; min: number },
): number {
  const value = env[name];
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min) {
    const kind = min === 0 ? 'a non-negative integer' : 'a positive integer';
    throw new Error(`${name}: \`${value}\` is not ${kind}.`);
  }
  return parsed;
}

/** `ai-sdk-sandbox-gce proxy`: serves the sandboxes and the administration API until stopped. */
export function main(env: Environment): void {
  const logger = createLogger({ json: env['LOG_FORMAT'] !== 'text' });
  const config = proxyConfig(env);
  if (config.allowPrivateNetwork) {
    logger.warn(
      'SANDBOX_ALLOW_PRIVATE_NETWORK=true: the sandboxes may reach the VPC and the metadata server. For tests only.',
    );
  }
  const registry = new SandboxRegistry(config.allowPrivateNetwork);
  const proxy = new EgressProxy((address) => registry.policyFor(address), logger, {
    maxConnections: config.maxConnections,
    routeConnections: config.routeConnections,
    totalConnections: config.totalConnections,
  });
  const admin = createAdminServer({ registry, token: config.token, logger });
  proxy.server.listen(config.port, config.host, () =>
    logger.info(`Egress proxy listening on ${config.host}:${config.port}`),
  );
  admin.listen(config.adminPort, config.host, () =>
    logger.info(`Administration API listening on ${config.host}:${config.adminPort}`),
  );
  // The direct connections, once the sandboxes' DNS answers the proxy's address for every name.
  if (config.tlsPort !== undefined) {
    const { tlsPort } = config;
    proxy.tlsServer.listen(tlsPort, config.host, () =>
      logger.info(`Direct TLS connections taken on ${config.host}:${tlsPort}`),
    );
  }
  if (config.httpPort !== undefined) {
    const { httpPort } = config;
    proxy.httpServer.listen(httpPort, config.host, () =>
      logger.info(`Direct HTTP requests taken on ${config.host}:${httpPort}`),
    );
  }
  const shutDown = (code: number): void => {
    proxy.close();
    admin.closeAllConnections();
    admin.close(() => process.exit(code));
  };
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => shutDown(0));
  }
  const { idleExitMs } = config;
  if (idleExitMs !== undefined) {
    watchIdle({
      idleMs: idleExitMs,
      sandboxes: () => registry.size,
      onIdle: () => {
        logger.info(`No sandbox for ${idleExitMs / 60_000} min: exiting for the machine to stop`);
        shutDown(IDLE_EXIT_CODE);
      },
    });
  }
}
