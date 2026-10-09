export { pluginHarnessSettings } from './agent/plugin-harness-settings.js';
export type { PluginHarnessSettings } from './agent/plugin-harness-settings.js';
export { withPlugins } from './agent/with-plugins.js';
export type {
  PluginAgentSettings,
  UnsupportedPluginFeature,
  WithPlugins,
  WithPluginsOptions,
} from './agent/with-plugins.js';
export { createCatalog } from './catalog/catalog.js';
export type { Catalog, CatalogEntry, CatalogSources, SelectOptions } from './catalog/catalog.js';
export type { CatalogDescription, CatalogItemDescription } from './catalog/describe-catalog.js';
export { describePlugin } from './catalog/describe-plugin.js';
export type { JsonSchema, PluginDescription } from './catalog/describe-plugin.js';
export { expandCommand, listSlashCommands } from './commands/expand-command.js';
export type {
  ExpandedCommand,
  SlashCommand,
  SlashCommandSource,
} from './commands/expand-command.js';
export { defineItem, definePlugin, itemJsonSchema, pluginJsonSchema } from './config/define.js';
export type { HttpToolResult } from './config/http-tool.js';
export { ITEM_KINDS, itemSchemas } from './config/item-schema.js';
export type { Item, ItemKind } from './config/item-schema.js';
export { pluginFingerprint } from './config/plugin-fingerprint.js';
export { pluginSchema } from './config/plugin-schema.js';
export { resolvePlugins } from './config/resolve-plugins.js';
export type {
  HostMcpClient,
  ResolvedPlugins,
  ResolveOptions,
  ResolvePluginsOptions,
} from './config/resolve-plugins.js';
export type { SandboxCommandResult } from './config/sandbox-command-tool.js';
export { PLUGIN_HOOK_EVENTS } from './definitions/plugin.js';
export type {
  InputSchema,
  Plugin,
  PluginCommand,
  PluginFile,
  PluginHook,
  PluginHookEvent,
  PluginMcpServer,
  PluginRule,
  PluginSkill,
  PluginSubagent,
  PluginTool,
  ResolvedMcpServer,
  SecretValue,
  ToolDefinition,
} from './definitions/plugin.js';
export { InvalidPluginError } from './errors/invalid-plugin-error.js';
export type { PluginIssue } from './errors/invalid-plugin-error.js';
export { PluginLoadError } from './errors/plugin-load-error.js';
export { loadClaudeCodePlugin } from './loader/load-claude-code-plugin.js';
export { mcpToolsPlugin } from './mcp/mcp-tools-plugin.js';
export type { McpToolSource, McpToolsPluginOptions } from './mcp/mcp-tools-plugin.js';
export type { PluginFeature } from './runtimes/plugin-runtime.js';
