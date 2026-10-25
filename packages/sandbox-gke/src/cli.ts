#!/usr/bin/env node

const USAGE = `Usage: ai-sdk-sandbox-gke <serve|proxy|agent>

  serve   The sandbox service, in the cluster: drives the pods of the sandboxes.
  proxy   The egress proxy, in the cluster: the sandboxes' only way out.
  agent   The agent of a sandbox's pod, its container's command.

Configured by environment variables: see
https://ai-sdk-harness.pages.dev/docs/packages/sandbox-gke
`;

/**
 * The package's command line: each runtime is loaded alone, so that the agent, in every sandbox's
 * pod, runs nothing of the service or the proxy.
 */
async function run(command: string | undefined): Promise<void> {
  if (command === 'serve') (await import('./server/main.js')).main(process.env);
  else if (command === 'proxy') (await import('./proxy/main.js')).main(process.env);
  else if (command === 'agent') (await import('./in-pod/main.js')).main(process.env);
  else if (command === '--help' || command === '-h') process.stdout.write(USAGE);
  else {
    process.stderr.write(USAGE);
    process.exitCode = 1;
  }
}

run(process.argv[2]).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
