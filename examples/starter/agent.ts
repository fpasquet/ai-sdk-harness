import { HarnessAgent } from '@ai-sdk/harness/agent';
import { createClaudeCode } from '@ai-sdk/harness-claude-code';
import {
  createSbxNetworkSandboxSession,
  resumeSbxNetworkSandboxSession,
  SbxSandboxNotFoundError,
} from 'ai-sdk-sandbox-sbx';

const prompt =
  process.argv.slice(2).join(' ') ||
  'Write a script that prints the first ten primes, then run it.';
const sandboxId = process.env.SANDBOX_ID || 'ai-sdk-harness-starter';

// Claude Code, authenticated from CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY, else the login of
// the `claude` CLI. Only a placeholder of the credential enters the sandbox.
const agent = new HarnessAgent({ harness: createClaudeCode() });

// One Docker Sandbox, kept between runs: the first run creates it, the next ones resume it. Each
// run is a new conversation, in a directory of its own.
async function openSandbox() {
  // The Claude Code bridge listens on this port, inside the sandbox.
  const ports = [4000];
  try {
    const sandbox = await resumeSbxNetworkSandboxSession({ sandboxId, ports });
    // A run stopped short may have left its bridge behind, holding the port.
    await sandbox.killAllProcesses();
    return sandbox;
  } catch (error) {
    if (!(error instanceof SbxSandboxNotFoundError)) throw error;
    return createSbxNetworkSandboxSession({
      sandboxId,
      ports,
      // The bridge installs its dependencies with pnpm.
      setup: ['npm install --global --silent pnpm@10'],
      // Installs Claude Code once, in a local image every later sandbox starts from.
      template: await agent.getSandboxTemplate(),
    });
  }
}

const sandboxSession = await openSandbox();
const session = await agent.createSession({ sandboxSession });

// Ctrl+C stops the turn, and still stops the sandbox below.
const abort = new AbortController();
process.once('SIGINT', () => abort.abort());

try {
  const result = await agent.stream({ session, prompt, abortSignal: abort.signal });
  for await (const part of result.fullStream) {
    if (part.type === 'text-delta') process.stdout.write(part.text);
    if (part.type === 'tool-call') process.stdout.write(`\n› ${part.toolName}\n`);
  }
  process.stdout.write('\n');
} finally {
  await session.destroy();
  // Stops the sandbox and keeps its files: `sbx rm ai-sdk-harness-starter` removes it.
  await sandboxSession.stop();
}
