import type { Tool } from '@ai-sdk/provider-utils';

import { z } from 'zod/v4';

import type { InputSchema, PluginTool, ToolDefinition } from '../definitions/plugin.js';

import {
  COMMAND_NAME,
  FILE_PATH,
  PLUGIN_HOOK_EVENTS,
  SERVER_NAME,
  SLUG,
} from '../definitions/plugin.js';
import { isCodeSchema, undeclaredPlaceholders } from './input-schema.js';

/** A name a model can call a tool by. */
export const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

const TOOL_TYPES = new Set(['http', 'registered', 'sandbox-command']);

/** Whether `tool` is written as configuration, rather than an AI SDK tool of code. */
export const isToolDefinition = (tool: PluginTool): tool is ToolDefinition =>
  TOOL_TYPES.has((tool as { type?: string }).type ?? '');

const text = z.string().min(1);
const slug = z.string().regex(SLUG, 'must be a kebab-case slug');
const secretValue = z.union([z.string(), z.strictObject({ secret: text })]);
const secrets = z.record(z.string(), secretValue);
const requires = z.array(text).optional();
const objectSchema = z
  .record(z.string(), z.unknown())
  .refine((schema) => schema.type === 'object', 'must be an object schema: { "type": "object" }');

/**
 * The input schema of a tool: a JSON Schema, or one written in code. The JSON Schema of a plugin
 * shows only the first, which JSON can hold (see `define.ts`).
 */
export const inputSchemaField = z.union([
  // First: a zod object schema has a `type` of "object" too.
  z.custom<InputSchema>(isCodeSchema),
  objectSchema,
]);

/** Each `{key}` of the URL of an `http` tool is a required property of its input schema. */
export const declaredPlaceholders = (
  tool: { url: string; inputSchema?: unknown },
  context: z.core.$RefinementCtx,
): void => {
  const missing = undeclaredPlaceholders(tool.url, tool.inputSchema);
  if (missing.length === 0) return;
  context.addIssue({
    code: 'custom',
    path: ['inputSchema'],
    message: `must declare ${missing.map((key) => `{${key}}`).join(', ')} of the url as required properties: the model fills only what the schema shows`,
  });
};

/** An absolute http(s) URL whose origin holds no `{key}`: the input never picks the host. */
const urlTemplate = z.string().refine((url) => {
  const origin = /^https?:\/\/[^/?#]+/.exec(url)?.[0];
  return origin !== undefined && !origin.includes('{');
}, 'must be an http(s) URL whose origin holds no {placeholder}');

export const toolFields = {
  'sandbox-command': {
    type: z.literal('sandbox-command'),
    description: text,
    inputSchema: inputSchemaField.optional(),
    command: text,
    timeoutSeconds: z.number().int().positive().max(3600).optional(),
    requires,
  },
  http: {
    type: z.literal('http'),
    description: text,
    inputSchema: inputSchemaField.optional(),
    method: z.enum(['DELETE', 'GET', 'PATCH', 'POST', 'PUT']).optional(),
    url: urlTemplate,
    headers: secrets.optional(),
    timeoutSeconds: z.number().int().positive().max(3600).optional(),
    requires,
  },
  registered: { type: z.literal('registered'), ref: text, requires },
};

/** A {@link ToolDefinition}. */
export const toolDefinitionSchema = z.discriminatedUnion('type', [
  z.strictObject(toolFields['sandbox-command']),
  z.strictObject(toolFields.http).superRefine(declaredPlaceholders),
  z.strictObject(toolFields.registered),
]);

/** An AI SDK tool, written in code: what it holds is the AI SDK's to check. */
const codeTool = z.custom<Tool>(
  (value) => typeof value === 'object' && value !== null && 'inputSchema' in value,
  'must be an AI SDK tool, or a tool definition of type http, sandbox-command or registered',
);

const tool = z.custom<PluginTool>().superRefine((value, context) => {
  const parsed = isToolDefinition(value)
    ? toolDefinitionSchema.safeParse(value)
    : codeTool.safeParse(value);
  for (const issue of parsed.error?.issues ?? []) context.addIssue({ ...issue });
});

const hostFields = {
  runIn: z.enum(['host', 'sandbox']).optional(),
  allowedTools: z.array(text).optional(),
};

export const mcpServerFields = {
  stdio: {
    type: z.literal('stdio'),
    command: text,
    args: z.array(z.string()).optional(),
    env: secrets.optional(),
    ...hostFields,
  },
  http: { type: z.literal('http'), url: z.url(), headers: secrets.optional(), ...hostFields },
};

/** A server the runtime starts in the sandbox holds no secret: its configuration is there. */
export const noSecretInSandbox = (server: {
  runIn?: string;
  headers?: Record<string, unknown>;
  env?: Record<string, unknown>;
}): boolean =>
  server.runIn !== 'sandbox' ||
  Object.values({ ...server.headers, ...server.env }).every((value) => typeof value === 'string');
export const NO_SECRET_IN_SANDBOX = {
  message:
    'holds a secret: an MCP server with credentials is connected by your server, not run in the sandbox',
};

const mcpServerSchema = z
  .discriminatedUnion('type', [
    z.strictObject(mcpServerFields.stdio),
    z.strictObject(mcpServerFields.http),
  ])
  .refine(noSecretInSandbox, NO_SECRET_IN_SANDBOX);

export const files = z.array(
  z.strictObject({
    path: z.string().regex(FILE_PATH, 'must be a relative path that stays in the plugin'),
    content: z.string(),
    executable: z.boolean().optional(),
  }),
);

export const skillFields = {
  name: slug,
  description: z.string(),
  content: z.string(),
  files: z.array(z.strictObject({ path: text, content: z.string() })).optional(),
  requires,
};

export const ruleFields = {
  name: slug,
  description: z.string().optional(),
  paths: z.array(text).optional(),
  content: text,
  requires,
};

export const commandFields = {
  name: z.string().regex(COMMAND_NAME, 'must be letters, digits, _ or -, and : namespaces'),
  description: z.string(),
  argumentHint: z.string().optional(),
  prompt: text,
  requires,
};

export const hookFields = {
  name: slug.optional(),
  event: z.enum(PLUGIN_HOOK_EVENTS),
  matcher: text.optional(),
  command: text.optional(),
  prompt: text.optional(),
  timeout: z.number().int().positive().optional(),
  description: z.string().optional(),
  requires,
};

/** A hook has exactly one of a command and a prompt. */
export const oneHandler = (hook: { command?: string; prompt?: string }): boolean =>
  (hook.command === undefined) !== (hook.prompt === undefined);
export const ONE_HANDLER = { message: 'needs exactly one of command and prompt' };

export const subagentFields = {
  name: slug,
  description: z.string(),
  instructions: z.string(),
  tools: z.array(text).optional(),
  model: text.optional(),
  requires,
};

export const toolName = z.string().regex(TOOL_NAME, 'must be letters, digits, _ or -, 64 at most');
export const serverName = z.string().regex(SERVER_NAME, 'must be letters, digits, _ or -');

const pluginHead = { name: slug, description: z.string(), version: z.string().optional() };

const pluginFields = {
  skills: z.array(z.strictObject(skillFields)).optional(),
  rules: z.array(z.strictObject(ruleFields)).optional(),
  commands: z.array(z.strictObject(commandFields)).optional(),
  hooks: z.array(z.strictObject(hookFields).refine(oneHandler, ONE_HANDLER)).optional(),
  subagents: z.array(z.strictObject(subagentFields)).optional(),
  mcpServers: z.record(serverName, mcpServerSchema).optional(),
  files: files.optional(),
};

/** A plugin, its tools AI SDK tools or definitions: what `definePlugin` checks. */
export const pluginSchema = z.strictObject({
  ...pluginHead,
  tools: z.record(toolName, tool).optional(),
  ...pluginFields,
});

/** A plugin as JSON can write it, its tools definitions: the schema of a form, as JSON Schema. */
export const pluginJsonSchemaSource = z.strictObject({
  ...pluginHead,
  tools: z.record(toolName, toolDefinitionSchema).optional(),
  ...pluginFields,
});
