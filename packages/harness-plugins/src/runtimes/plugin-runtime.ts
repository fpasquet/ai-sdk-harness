import type { Plugin, PluginHook, ResolvedMcpServer } from '../definitions/plugin.js';

/** What a plugin can hold that not every runtime can take. */
export type PluginFeature = 'hooks' | 'mcpServers' | 'subagents';

/** A file to write in the session's working directory, at `path` relative to it. */
export interface SessionFile {
  path: string;
  content: string;
  executable?: boolean;
}

/** What a runtime needs written in a session's working directory before it starts. */
export interface SessionLayout {
  files: SessionFile[];
  /** Claude Code hook groups by event, merged into `.claude/settings.local.json`. */
  hookGroups: Record<string, unknown[]>;
}

/** What the plugins set on a runtime's harness adapter, besides their MCP servers. */
export interface RuntimeAdapterSettings {
  /** Codex configuration, for the `codexConfig` of `createCodex()`. */
  codexConfig?: Record<string, unknown>;
}

/**
 * How the plugins reach one runtime: which of their features it takes, the native form of an MCP
 * server, and what goes in a session's working directory. Tools, skills and commands need none of
 * this: the harness and your server handle them the same way for every runtime.
 */
export interface PluginRuntime {
  readonly harnessId: string;
  readonly supports: Readonly<Record<PluginFeature, boolean>>;
  /**
   * Where the rules go: in files the runtime reads (`layout` writes them), or in the agent's
   * instructions, which every runtime takes.
   */
  readonly rules: 'files' | 'instructions';
  readonly mcpServer: (server: ResolvedMcpServer) => unknown;
  /**
   * What the runtime reads from the session's working directory, besides the plugins' own files.
   * `pluginRoot` is the absolute path, in the sandbox, of a plugin's directory.
   */
  readonly layout: (
    plugins: readonly Plugin[],
    pluginRoot: (plugin: string) => string,
  ) => SessionLayout;
  /**
   * Whether the runtime takes `hook`, when it takes hooks: some have events, or forms, it has not.
   * Every hook when absent.
   */
  readonly takesHook?: (hook: PluginHook) => boolean;
  /**
   * What the plugins set on the harness adapter, besides their MCP servers: what the runtime reads
   * from its configuration rather than from the session's working directory. `pluginRoot` is the
   * directory of a plugin's files, relative to the session's working directory. Nothing when
   * absent.
   */
  readonly adapterSettings?: (
    plugins: readonly Plugin[],
    pluginRoot: (plugin: string) => string,
  ) => RuntimeAdapterSettings;
}

/** Whether `runtime` takes `hook`. */
export const takesHook = (runtime: PluginRuntime, hook: PluginHook): boolean =>
  runtime.supports.hooks && (runtime.takesHook?.(hook) ?? true);

/** A layout with nothing in it. */
export const EMPTY_LAYOUT: SessionLayout = { files: [], hookGroups: {} };
