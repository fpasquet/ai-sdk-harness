#!/usr/bin/env node
import { listenConfig, sandboxesConfig } from './config.js';
import { createLogger } from './logger.js';
import { createSandboxServer } from './sandbox-server.js';

const USAGE = `Usage: ai-sdk-sandbox-cloud-run serve

Runs the sandbox service of ai-sdk-sandbox-cloud-run, in a Cloud Run service deployed with
--sandbox-launcher. Configured by environment variables: see
https://ai-sdk-harness.pages.dev/docs/packages/sandbox-cloud-run#service-configuration
`;

/** Serves until Cloud Run stops the instance: the running sandboxes are then saved. */
function serve(): void {
  const config = listenConfig(process.env);
  const logger = createLogger({ json: config.jsonLogs });
  const service = createSandboxServer(sandboxesConfig(process.env, logger));
  service.server.listen(config.port, config.host, () =>
    logger.info(`Listening on ${config.host}:${config.port}`),
  );
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      logger.info(`${signal}: saving the running sandboxes`);
      void service.close().finally(() => process.exit(0));
    });
  }
}

const [command] = process.argv.slice(2);
if (command === 'serve') {
  serve();
} else if (command === '--help' || command === '-h') {
  process.stdout.write(USAGE);
} else {
  process.stderr.write(USAGE);
  process.exitCode = 1;
}
