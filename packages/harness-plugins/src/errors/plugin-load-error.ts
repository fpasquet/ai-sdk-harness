/** What `isInstance` looks for, shared by every copy of this package. */
const MARKER: unique symbol = Symbol.for('ai-sdk-harness-plugins.PluginLoadError');

/** A plugin directory could not be read as a Claude Code plugin. */
export class PluginLoadError extends Error {
  private readonly [MARKER] = true;

  /** The directory, or the file in it, that could not be read. */
  readonly path: string;

  constructor(path: string, reason: string) {
    super(`Cannot load the plugin at ${path}: ${reason}`);
    this.name = 'PluginLoadError';
    this.path = path;
  }

  /**
   * Whether `error` is one, rather than `instanceof`: a bundler may load this package twice — Next.js
   * does, for a route and a page —, each copy with its own class.
   */
  static isInstance(error: unknown): error is PluginLoadError {
    return typeof error === 'object' && error !== null && MARKER in error;
  }
}
