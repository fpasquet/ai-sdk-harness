import { createLogger } from '../common/logger.js';
import { listenConfig, sandboxesConfig } from './config.js';
import { createSandboxServer } from './http/sandbox-server.js';

/**
 * `ai-sdk-sandbox-gke serve`: serves the sandbox service until Kubernetes stops the pod. The
 * sandboxes run on in their own pods: another replica serves them.
 */
export function main(env: Readonly<Record<string, string | undefined>>): void {
  const config = listenConfig(env);
  const logger = createLogger({ json: config.jsonLogs });
  const service = createSandboxServer(sandboxesConfig(env, logger));
  service.server.listen(config.port, config.host, () =>
    logger.info(`Listening on ${config.host}:${config.port}`),
  );
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => void service.close().finally(() => process.exit(0)));
  }
}
