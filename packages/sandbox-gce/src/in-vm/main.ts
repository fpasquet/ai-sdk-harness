import { createLogger } from '../common/logger.js';
import { agentListenConfig, agentSettings } from './agent-config.js';
import { createAgentServer } from './agent-server.js';

/**
 * `ai-sdk-sandbox-gce agent`: serves the agent of a sandbox's machine until systemd stops it, the
 * processes it started stopped with it.
 */
export async function main(env: Readonly<Record<string, string | undefined>>): Promise<void> {
  const logger = createLogger({ json: env['LOG_FORMAT'] !== 'text' });
  const config = agentListenConfig(env);
  const agent = createAgentServer(await agentSettings(env, logger));
  agent.server.listen(config.port, config.host, () =>
    logger.info(`Agent listening on ${config.host}:${config.port}`),
  );
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => void agent.close().finally(() => process.exit(0)));
  }
}
