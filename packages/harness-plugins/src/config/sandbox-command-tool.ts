import type { Tool } from '@ai-sdk/provider-utils';

import { tool } from '@ai-sdk/provider-utils';

import type { ToolDefinition } from '../definitions/plugin.js';

import { toolInputSchema } from './input-schema.js';

/** What a command hands back of each stream: past it, the agent reads a note instead. */
export const MAX_OUTPUT = 20_000;

/** What the agent reads of a command it ran. */
export type SandboxCommandResult =
  { exitCode: null; error: string } | { exitCode: number; stdout: string; stderr: string };

/**
 * The AI SDK tool of a `sandbox-command` tool of a manifest: on your server, it runs the command in
 * the sandbox the harness hands it, with the input as environment variables only.
 */
export function sandboxCommandTool(
  definition: Extract<ToolDefinition, { type: 'sandbox-command' }>,
): Tool {
  const { description, command, timeoutSeconds = 30 } = definition;
  return tool({
    description,
    inputSchema: toolInputSchema(definition.inputSchema),
    execute: async (
      input,
      { abortSignal, experimental_sandbox: sandbox },
    ): Promise<SandboxCommandResult> => {
      if (sandbox === undefined) return { exitCode: null, error: 'This tool needs a sandbox.' };
      const deadline = AbortSignal.timeout(timeoutSeconds * 1000);
      try {
        const result = await sandbox.run({
          command,
          env: environmentOf(input),
          abortSignal: abortSignal ? AbortSignal.any([abortSignal, deadline]) : deadline,
        });
        return {
          exitCode: result.exitCode,
          stdout: clip(result.stdout),
          stderr: clip(result.stderr),
        };
      } catch (error) {
        if (!deadline.aborted || abortSignal?.aborted) throw error;
        return { exitCode: null, error: `Stopped after ${timeoutSeconds} s.` };
      }
    },
  });
}

/** `INPUT` as JSON, and `INPUT_<KEY>` for each top-level property. */
export function environmentOf(input: Record<string, unknown>): Record<string, string> {
  const env: Record<string, string> = { INPUT: JSON.stringify(input ?? {}) };
  for (const [key, value] of Object.entries(input ?? {})) {
    if (value === undefined) continue;
    env[`INPUT_${key.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`] =
      typeof value === 'string' ? value : JSON.stringify(value);
  }
  return env;
}

/** `output`, cut past {@link MAX_OUTPUT} characters with a note saying how much. */
export function clip(output: string): string {
  return output.length <= MAX_OUTPUT
    ? output
    : `${output.slice(0, MAX_OUTPUT)}\n[… ${output.length - MAX_OUTPUT} more characters cut]`;
}
