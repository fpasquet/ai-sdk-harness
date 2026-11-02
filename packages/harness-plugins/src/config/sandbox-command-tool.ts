import type { Tool } from '@ai-sdk/provider-utils';

import { tool } from '@ai-sdk/provider-utils';

import type { PluginFile, ToolDefinition } from '../definitions/plugin.js';
import type { ToolFiles } from '../session/sync-tool-files.js';

import { PLUGIN_ROOT } from '../definitions/plugin.js';
import { InvalidPluginError } from '../errors/invalid-plugin-error.js';
import { toolFilesRoot } from '../session/sync-tool-files.js';
import { toolInputSchema } from './input-schema.js';
import { inputVariable } from './input-variables.js';

/** What a command hands back of each stream: past it, the agent reads a note instead. */
export const MAX_OUTPUT = 20_000;

/** What the agent reads of a command it ran. */
export type SandboxCommandResult =
  { exitCode: null; error: string } | { exitCode: number; stdout: string; stderr: string };

/** The files each tool built here reaches through `${PLUGIN_ROOT}`: what a session writes for it. */
const TOOL_FILES = new WeakMap<Tool, ToolFiles>();

/** The files `tool` needs in the sandbox, for a `sandbox-command` citing `${PLUGIN_ROOT}`. */
export const toolFilesOf = (tool: Tool): ToolFiles | undefined => TOOL_FILES.get(tool);

/**
 * The AI SDK tool of a `sandbox-command` tool of plugin `plugin`: on your server, it runs the
 * command in the sandbox the harness hands it, with the input as environment variables only.
 * `${PLUGIN_ROOT}` in the command becomes the directory, under the sandbox's `$HOME`, where
 * `withPlugins` writes the plugin's files for it; throws {@link InvalidPluginError} when the plugin
 * has none.
 */
export function sandboxCommandTool(
  definition: Extract<ToolDefinition, { type: 'sandbox-command' }>,
  plugin: { name: string; files?: readonly PluginFile[] },
): Tool {
  const { description, timeoutSeconds = 30 } = definition;
  const files = plugin.files ?? [];
  const cites = definition.command.match(PLUGIN_ROOT) !== null;
  if (cites && files.length === 0) {
    throw new InvalidPluginError(
      'a sandbox-command cites ${PLUGIN_ROOT}, and the plugin has no files for it to point at.',
      plugin.name,
    );
  }
  const root = cites ? toolFilesRoot(plugin.name, files) : undefined;
  // `$HOME` rather than its value, which only the sandbox knows: the shell expands it.
  const command =
    root === undefined
      ? definition.command
      : definition.command.replace(PLUGIN_ROOT, () => `$HOME/${root}`);
  const built = tool({
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
  if (root !== undefined) TOOL_FILES.set(built, { root, files });
  return built;
}

/** `INPUT` as JSON, and `INPUT_<KEY>` for each top-level property. */
export function environmentOf(input: Record<string, unknown>): Record<string, string> {
  const env: Record<string, string> = { INPUT: JSON.stringify(input ?? {}) };
  for (const [key, value] of Object.entries(input ?? {})) {
    if (value === undefined) continue;
    env[inputVariable(key)] = typeof value === 'string' ? value : JSON.stringify(value);
  }
  return env;
}

/** `output`, cut past {@link MAX_OUTPUT} characters with a note saying how much. */
export function clip(output: string): string {
  return output.length <= MAX_OUTPUT
    ? output
    : `${output.slice(0, MAX_OUTPUT)}\n[… ${output.length - MAX_OUTPUT} more characters cut]`;
}
