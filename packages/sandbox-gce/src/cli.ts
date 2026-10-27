#!/usr/bin/env node

const USAGE = `Usage: ai-sdk-sandbox-gce <serve|proxy|agent>

  serve   The sandbox service, in a Cloud Run service: drives the machines of the sandboxes.
  proxy   The egress proxy, on a machine of its own: the sandboxes' only way out.
  agent   The agent of a sandbox's machine, run by systemd from the sandbox image.

Configured by environment variables: see
https://ai-sdk-harness.pages.dev/docs/packages/sandbox-gce
`;

/**
 * The package's command line: each runtime is loaded alone, so that the agent, in every sandbox
 * machine, runs nothing of the service or the proxy.
 */
async function run(command: string | undefined): Promise<void> {
  if (command === 'serve') await (await import('./server/main.js')).main(process.env);
  else if (command === 'proxy') (await import('./proxy/main.js')).main(process.env);
  else if (command === 'agent') await (await import('./in-vm/main.js')).main(process.env);
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
