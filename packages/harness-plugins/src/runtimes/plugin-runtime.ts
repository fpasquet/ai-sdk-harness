import type { Plugin, PluginHook, ResolvedMcpServer } from '../definitions/plugin.js';

/** What a plugin can hold that not every runtime can take. */
export type PluginFeature = 'hooks' | 'mcpServers' | 'subagents';

/** A file to write, at `path` relative to the session's working directory or to `$HOME`. */
export interface SessionFile {
  path: string;
  content: string;
  executable?: boolean;
}

/** What a runtime needs written for a session before it starts. */
export interface SessionLayout {
  files: SessionFile[];
  /**
   * Files to write under the sandbox's `$HOME`, at `path` relative to it, for what the runtime
   * reads only there. Every session of the sandbox shares them. Absent for a runtime that reads
   * nothing there: its sessions then leave alone what another runtime's wrote.
   */
  homeFiles?: SessionFile[];
  /**
   * Claude Code hook groups by event, added to `$HOME/.claude/settings.json`, where they stay for
   * the sandbox's life: each one runs only in the sessions that have it.
   */
  hookGroups: Record<string, unknown[]>;
  /**
   * Whether `hookGroups` are the plugins' hooks as they declare them, for a sandbox that is the
   * session's own: they replace every hook the plugins wrote in `$HOME` before, the gate's
   * included. Otherwise they go through the gate, and are added to those of the other sessions.
   */
  directHooks?: boolean;
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
  readonly mcpServer: (server: ResolvedMcpServer) => unknown;
  /**
   * What the runtime reads from the session's working directory, or the sandbox's `$HOME`, besides
   * the plugins' own files.
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
