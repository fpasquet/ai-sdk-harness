import { createLogger } from '../common/logger.js';
import { DEFAULT_PROXY_ADMIN_PORT, DEFAULT_PROXY_PORT } from '../protocol/proxy.js';
import { createAdminServer } from './admin-server.js';
import { DEFAULT_MAX_CONNECTIONS, EgressProxy } from './egress-proxy.js';
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
    maxConnections: maxConnections(env['SANDBOX_PROXY_MAX_CONNECTIONS']),
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

/** `SANDBOX_PROXY_MAX_CONNECTIONS`, a positive integer: {@link DEFAULT_MAX_CONNECTIONS} when unset. */
function maxConnections(value: string | undefined): number {
  if (value === undefined || value === '') return DEFAULT_MAX_CONNECTIONS;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`SANDBOX_PROXY_MAX_CONNECTIONS: \`${value}\` is not a positive integer.`);
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
  const registry = new SandboxRegistry(config.allowPrivateNetwork, logger);
  const proxy = new EgressProxy((address) => registry.policyFor(address), logger, {
    maxConnections: config.maxConnections,
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
      sandboxes: () => registry.list().length,
      onIdle: () => {
        logger.info(`No sandbox for ${idleExitMs / 60_000} min: exiting for the machine to stop`);
        shutDown(IDLE_EXIT_CODE);
      },
    });
  }
}
