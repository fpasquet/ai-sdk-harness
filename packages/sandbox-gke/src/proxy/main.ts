import { createLogger } from '../common/logger.js';
import { DEFAULT_PROXY_ADMIN_PORT, DEFAULT_PROXY_PORT } from '../protocol/proxy.js';
import { createAdminServer } from './admin-server.js';
import { EgressProxy } from './egress-proxy.js';
import { SandboxRegistry } from './registry.js';

type Environment = Readonly<Record<string, string | undefined>>;

/** The proxy's settings, from its environment, which its Deployment sets. */
export function proxyConfig(env: Environment): {
  adminPort: number;
  allowPrivateNetwork: boolean;
  host: string;
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
    token,
  };
}

/** `ai-sdk-sandbox-gke proxy`: serves the sandboxes and the administration API until stopped. */
export function main(env: Environment): void {
  const logger = createLogger({ json: env['LOG_FORMAT'] !== 'text' });
  const config = proxyConfig(env);
  if (config.allowPrivateNetwork) {
    logger.warn(
      'SANDBOX_ALLOW_PRIVATE_NETWORK=true: the sandboxes may reach the cluster, the VPC and the metadata server. For tests only.',
    );
  }
  const registry = new SandboxRegistry(config.allowPrivateNetwork);
  const proxy = new EgressProxy((address) => registry.policyFor(address));
  const admin = createAdminServer({ registry, token: config.token, logger });
  proxy.server.listen(config.port, config.host, () =>
    logger.info(`Egress proxy listening on ${config.host}:${config.port}`),
  );
  admin.listen(config.adminPort, config.host, () =>
    logger.info(`Administration API listening on ${config.host}:${config.adminPort}`),
  );
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      proxy.close();
      admin.closeAllConnections();
      admin.close(() => process.exit(0));
    });
  }
}
