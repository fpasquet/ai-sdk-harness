/** One mistake in a plugin, at `path` within it: `["hooks", 0, "event"]`. */
export interface PluginIssue {
  path: (number | string)[];
  message: string;
}

/** What `isInstance` looks for, shared by every copy of this package. */
const MARKER: unique symbol = Symbol.for('ai-sdk-harness-plugins.InvalidPluginError');

/**
 * A plugin, or a set of plugins, cannot be used as it is: a name that is not a slug, two items
 * under one name, a tool named like one of the runtime's own… The message says which and where.
 */
export class InvalidPluginError extends Error {
  private readonly [MARKER] = true;

  /** The plugin at fault, when the error is about one plugin. */
  readonly plugin: string | undefined;
  /**
   * Every mistake found, by field, when a plugin or an item was checked by `definePlugin` or
   * `defineItem`: what a back office shows next to each field of its form.
   */
  readonly issues: readonly PluginIssue[];

  constructor(message: string, plugin?: string, issues: readonly PluginIssue[] = []) {
    super(plugin === undefined ? message : `Plugin "${plugin}": ${message}`);
    this.name = 'InvalidPluginError';
    this.plugin = plugin;
    this.issues = issues;
  }

  /**
   * Whether `error` is one, rather than `instanceof`: a bundler may load this package twice — Next.js
   * does, for a route and a page —, each copy with its own class.
   */
  static isInstance(error: unknown): error is InvalidPluginError {
    return typeof error === 'object' && error !== null && MARKER in error;
  }
}
