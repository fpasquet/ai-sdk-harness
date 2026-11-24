import { createLogger } from '../common/logger.js';
import { DEFAULT_PROXY_ADMIN_PORT, DEFAULT_PROXY_PORT } from '../protocol/proxy.js';
import { createAdminServer } from './admin-server.js';
import { DEFAULT_MAX_CONNECTIONS, DEFAULT_ROUTE_CONNECTIONS, EgressProxy } from './egress-proxy.js';
import { IDLE_EXIT_CODE, watchIdle } from './idle-exit.js';
import { SandboxRegistry } from './registry.js';

type Environment = Readonly<Record<string, string | undefined>>;

/** The proxy's settings, from its environment, which the systemd unit of its machine sets. */
export function proxyConfig(env: Environment): {
  adminPort: number;
  allowPrivateNetwork: boolean;
  host: string;
  /** How long the proxy runs with no sandbox before it exits for its machine to power off. */
  idleExitMs?: number;
  maxConnections: number;
  port: number;
  routeConnections: number;
  token: string;
} {
  const token = env['SANDBOX_PROXY_TOKEN'];
  if (token === undefined || token.length < 16) {
    throw new Error(
      'SANDBOX_PROXY_TOKEN is required, 16 characters at least: the sandbox service proves itself with it.',
    );
  }
  return {
    port: Number.parseInt(env['SANDBOX_PROXY_PORT'] ?? String(DEFAULT_PROXY_PORT), 10),
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
    idleExitMs: idleExitMs(env['SANDBOX_PROXY_IDLE_EXIT_MINUTES']),
    token,
  };
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
  });
  const admin = createAdminServer({ registry, token: config.token, logger });
  proxy.server.listen(config.port, config.host, () =>
    logger.info(`Egress proxy listening on ${config.host}:${config.port}`),
  );
  admin.listen(config.adminPort, config.host, () =>
    logger.info(`Administration API listening on ${config.host}:${config.adminPort}`),
  );
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
